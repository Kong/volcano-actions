'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { recordRound, roundOf, ledgerOf, costBody, totals, keptRounds } = require('./ledger.cjs');
const { costMarker } = require('./constants.cjs');
const { sha, context } = require('./test-helpers.cjs');
const { commentsClient, noWait, round } = require('./test-cost.cjs');

test('the cost comment adds each run once and totals finished and cancelled rounds apart', async () => {
  const c = commentsClient();
  const ctx = context();
  await recordRound(
    { github: c.github, context: ctx },
    '9/1',
    round('finished', 6.4, 3, '2026-11-11T10:00:00Z'),
    noWait,
  );
  await recordRound(
    { github: c.github, context: ctx },
    '10/1',
    round('cancelled', 1, 0.5, '2026-11-11T11:00:00Z'),
    noWait,
  );
  // A re-run of the cost step changes nothing.
  await recordRound(
    { github: c.github, context: ctx },
    '10/1',
    round('cancelled', 1, 0.5, '2026-11-11T11:00:00Z'),
    noWait,
  );
  const [comment] = c.comments();
  assert.equal(c.comments().length, 1);
  assert.ok(comment.body.startsWith(costMarker));
  assert.match(comment.body, /\*\*AI review cost:\*\* ~\$10\.90 over 2 rounds/u);
  assert.match(comment.body, /- Finished: \$9\.40 \(1 round\)/u);
  assert.match(comment.body, /- Cancelled: ~\$1\.50 \(1 round\)/u);
  assert.deepEqual(Object.keys(ledgerOf(comment).rounds).toSorted(), ['10/1', '9/1']);
});

test('the cost comment folds duplicate comments into one and keeps every round', async () => {
  const one = { rounds: { '1/1': round('finished', 1, 1, '2026-11-11T09:00:00Z') } };
  const two = { rounds: { '2/1': round('cancelled', 2, 0, '2026-11-11T09:30:00Z') } };
  const c = commentsClient([
    { id: 1, user: { login: 'someone' }, body: `${costMarker}\nnot ours` },
    { id: 2, user: { login: 'github-actions[bot]' }, body: costBody({ ...ledgerOf(null), ...one }) },
    { id: 3, user: { login: 'github-actions[bot]' }, body: costBody({ ...ledgerOf(null), ...two }) },
  ]);
  await recordRound(
    { github: c.github, context: context() },
    '3/1',
    round('finished', 1, 1, '2026-11-11T10:00:00Z'),
    noWait,
  );
  const ours = c.comments().filter((x) => x.user.login === 'github-actions[bot]');
  assert.equal(ours.length, 1);
  assert.deepEqual(Object.keys(ledgerOf(ours[0]).rounds).toSorted(), ['1/1', '2/1', '3/1']);
  assert.equal(c.comments().length, 2);
});

test('old rounds fold into running totals so the comment stays within its size limit', () => {
  const ledger = ledgerOf(null);
  for (let i = 0; i < keptRounds + 40; i += 1) {
    const at = new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString();
    ledger.rounds[`${i}/1`] = round(i % 2 ? 'cancelled' : 'finished', 1.23456, 0.5, at);
  }
  const body = costBody(ledger);
  assert.ok(body.length < 65_536, `${body.length} characters`);
  const kept = ledgerOf({ body });
  assert.equal(Object.keys(kept.rounds).length, keptRounds);
  assert.ok(!kept.rounds['0/1'] && kept.rounds[`${keptRounds + 39}/1`]);
  const sums = totals(kept);
  assert.equal(sums.finished.rounds + sums.cancelled.rounds, keptRounds + 40);
  assert.equal((sums.finished.cost + sums.cancelled.cost).toFixed(2), ((keptRounds + 40) * 1.7346).toFixed(2));
  // Only cancelled rounds were partial, so finished spend stays exact.
  assert.deepEqual([sums.finished.partial, sums.cancelled.partial], [false, true]);
});

test('a folded round written again changes nothing', async () => {
  const ledger = ledgerOf(null);
  for (let i = 0; i < keptRounds + 1; i += 1) {
    ledger.rounds[`${i}/1`] = round('finished', 1, 0, new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString());
  }
  const c = commentsClient([{ id: 2, user: { login: 'github-actions[bot]' }, body: costBody(ledger) }]);
  const before = c.comments()[0].body;
  await recordRound(
    { github: c.github, context: context() },
    '0/1',
    round('finished', 1, 0, '2026-11-01T00:00:00Z'),
    noWait,
  );
  assert.equal(c.comments()[0].body, before);
  assert.equal(totals(ledgerOf(c.comments()[0])).finished.rounds, keptRounds + 1);
});

test('a run counts as cancelled when any reviewer was, and as partial when any stopped early', () => {
  const spend = [
    { reviewer: 'Claude', state: 'finished', partial: false, known: true, cost: 1 },
    { reviewer: 'Codex', state: 'cancelled', partial: true, known: true, cost: 0.5 },
  ];
  const r = roundOf(sha, spend, '2026-11-11T10:00:00Z');
  assert.deepEqual([r.state, r.partial, r.by], ['cancelled', true, { Claude: 1, Codex: 0.5 }]);
});

test('a write from a stale read cannot drop a round for good', async () => {
  const c = commentsClient();
  const ctx = context();
  // Another run read the empty ledger before this run wrote, and writes after.
  const staleLedger = ledgerOf(null);
  staleLedger.rounds['8/1'] = round('finished', 2, 2, '2026-11-11T09:00:00Z');
  const stale = costBody(staleLedger);
  let clobbered = false;
  const wait = () => {
    if (!clobbered) {
      clobbered = true;
      const [comment] = c.comments();
      return c.github.rest.issues.updateComment({ comment_id: comment.id, body: stale });
    }
    return Promise.resolve();
  };
  await recordRound({ github: c.github, context: ctx }, '9/1', round('finished', 1, 1, '2026-11-11T10:00:00Z'), {
    wait,
  });
  assert.deepEqual(Object.keys(ledgerOf(c.comments()[0]).rounds).toSorted(), ['8/1', '9/1']);
});

test('a writer whose reads are always stale never writes and says it could not record', async () => {
  const c = commentsClient();
  let clock = 0;
  // Every read takes four seconds, longer than a read may be trusted.
  const now = () => (clock += 4000);
  await assert.rejects(
    recordRound({ github: c.github, context: context() }, '9/1', round('finished', 1, 1, '2026-11-11T10:00:00Z'), {
      ...noWait,
      now,
    }),
    /could not confirm round 9\/1/u,
  );
  assert.deepEqual(c.calls, []);
});

test('ledger writes are never retried, so a late retry cannot land a stale copy', async () => {
  const c = commentsClient();
  const options = [];
  const create = c.github.rest.issues.createComment;
  c.github.rest.issues.createComment = (args) => {
    options.push(args.request);
    return create(args);
  };
  await recordRound(
    { github: c.github, context: context() },
    '9/1',
    round('finished', 1, 1, '2026-11-11T10:00:00Z'),
    noWait,
  );
  assert.deepEqual(options, [{ retries: 0 }]);
});

test('a duplicate another writer already deleted does not stop the round being recorded', async () => {
  const bot = { login: 'github-actions[bot]' };
  const c = commentsClient([{ id: 2, user: bot, body: costBody(ledgerOf(null)) }]);
  // The listing still shows a duplicate another writer has since deleted.
  const list = c.github.paginate;
  c.github.paginate = async (...args) => [
    ...(await list(...args)),
    { id: 3, user: bot, body: costBody(ledgerOf(null)) },
  ];
  await recordRound(
    { github: c.github, context: context() },
    '9/1',
    round('finished', 1, 1, '2026-11-11T10:00:00Z'),
    noWait,
  );
  assert.deepEqual(Object.keys(ledgerOf(c.comments()[0]).rounds), ['9/1']);

  // A duplicate deleted between this writer's read and its delete.
  const d = commentsClient([
    { id: 2, user: bot, body: costBody(ledgerOf(null)) },
    { id: 3, user: bot, body: costBody(ledgerOf(null)) },
  ]);
  const remove = d.github.rest.issues.deleteComment;
  d.github.rest.issues.deleteComment = async (args) => {
    await remove(args);
    return remove(args);
  };
  await recordRound(
    { github: d.github, context: context() },
    '9/1',
    round('finished', 1, 1, '2026-11-11T10:00:00Z'),
    noWait,
  );
  assert.deepEqual(Object.keys(ledgerOf(d.comments()[0]).rounds), ['9/1']);
});

test('the legend names no provider', () => {
  assert.doesNotMatch(costBody(ledgerOf(null)), /Claude|Codex|ChatGPT/u);
});
