'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { cost } = require('./cost.cjs');
const { runSpend } = require('./spend.cjs');
const { recordRound, roundOf, ledgerOf, costBody, totals, keptRounds } = require('./ledger.cjs');
const { exportSpend, parseHeaders } = require('./otlp.cjs');
const { costMarker } = require('./constants.cjs');
const { tempDir } = require('./test-git.cjs');
const { sha, clearAfter, context, core } = require('./test-helpers.cjs');

const tokens = (input, output, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
});
const claudeUsage = { provider: 'claude', models: { 'claude-opus-5-5': { calls: 3, tokens: tokens(1e6, 1e5, 2e6) } } };
const codexUsage = { provider: 'codex', models: { 'gpt-6.1-sol': { calls: 2, tokens: tokens(1e6, 1e5) } } };
const needs = (claude, codex = claude, extra = {}) =>
  JSON.stringify({
    claude: { result: claude, outputs: claude === 'skipped' ? {} : { reviewer: 'Claude', model: 'claude-opus-5-5' } },
    codex: { result: codex, outputs: codex === 'skipped' ? {} : { reviewer: 'Codex', model: 'gpt-6.1-sol' } },
    ...extra,
  });
function usageDir(t, files = null) {
  const dir = tempDir(t, 'usage-');
  for (const [id, usage] of Object.entries(files ?? { claude: claudeUsage, codex: codexUsage })) {
    fs.writeFileSync(path.join(dir, `ai-review-usage-${id}.json`), JSON.stringify(usage));
  }
  return dir;
}

test('spend prices each reviewer and says how its run ended', (t) => {
  const dir = usageDir(t);
  const [claude, codex] = runSpend(needs('success'), dir, false);
  // 1M input at $4, 100k output at $20, 2M cache reads at $0.20.
  assert.equal(claude.cost.toFixed(2), '6.40');
  assert.deepEqual(
    [claude.state, claude.reason, claude.partial, claude.basis],
    ['finished', 'completed', false, 'api'],
  );
  assert.equal(codex.cost.toFixed(2), '3.00');
  assert.equal(codex.basis, 'list_price_equivalent');

  const [cancelled] = runSpend(needs('cancelled'), dir, true);
  assert.deepEqual([cancelled.state, cancelled.reason, cancelled.partial], ['cancelled', 'superseded', true]);
  assert.equal(runSpend(needs('cancelled'), dir, false)[0].reason, 'manual');
  assert.equal(runSpend(needs('failure'), dir, false)[0].reason, 'failed');
});

test('spend skips skipped reviewers and jobs that are not reviewers, and flags missing usage', (t) => {
  const dir = usageDir(t, { codex: codexUsage });
  const spend = runSpend(needs('cancelled', 'skipped', { verdict: { result: 'skipped', outputs: {} } }), dir, true);
  assert.deepEqual(
    spend.map((r) => [r.reviewer, r.recorded, r.cost]),
    [['Claude', false, 0]],
  );
  assert.deepEqual(
    runSpend(needs('skipped'), dir, false).map((r) => r.reviewer),
    [],
  );
});

// Answers like an Octokit method: always a promise.
const resolved =
  (fn) =>
  (...args) =>
    Promise.resolve(fn(...args));

// A PR's issue comments that the cost step reads and writes.
function commentsClient(initial = []) {
  let comments = initial.map((c) => ({ ...c }));
  let next = 100;
  const calls = [];
  const github = {
    paginate: resolved(() => comments.map((c) => ({ ...c }))),
    rest: {
      issues: {
        listComments: () => {},
        createComment: resolved(({ body }) => {
          calls.push('create');
          comments.push({ id: (next += 1), user: { login: 'github-actions[bot]' }, body });
          return { data: {} };
        }),
        updateComment: resolved(({ comment_id: id, body }) => {
          calls.push('update');
          comments = comments.map((c) => (c.id === id ? { ...c, body } : c));
          return { data: {} };
        }),
        deleteComment: resolved(({ comment_id: id }) => {
          calls.push('delete');
          comments = comments.filter((c) => c.id !== id);
          return { data: {} };
        }),
      },
      pulls: { get: resolved(() => ({ data: { head: { sha: 'fedcba9876543210' } } })) },
    },
  };
  return { github, calls, comments: () => comments };
}
const noWait = async () => {};
const round = (state, claude, codex, at, partial = state === 'cancelled') => ({
  sha,
  at,
  state,
  partial,
  by: { Claude: claude, Codex: codex },
});

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
});

test('a run counts as cancelled when any reviewer was, and as partial when any stopped early', () => {
  const spend = [
    { reviewer: 'Claude', state: 'finished', partial: false, cost: 1 },
    { reviewer: 'Codex', state: 'cancelled', partial: true, cost: 0.5 },
  ];
  const r = roundOf(sha, spend, '2026-11-11T10:00:00Z');
  assert.deepEqual([r.state, r.partial, r.by], ['cancelled', true, { Claude: 1, Codex: 0.5 }]);
});

test('OTLP headers parse as OpenTelemetry writes them', () => {
  assert.deepEqual(parseHeaders('Authorization=Bearer abc=,Dash0-Dataset=volcano, x = a%20b ,bad'), {
    Authorization: 'Bearer abc=',
    'Dash0-Dataset': 'volcano',
    x: 'a b',
  });
});

test('the export sends metrics and logs with the run and each reviewer', async (t) => {
  const sent = [];
  const fetchImpl = resolved((url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true };
  });
  const run = { repo: 'Kong/volcano-hosting', pr: 7, sha, runId: 9, attempt: 1, url: 'u' };
  const spend = runSpend(needs('success', 'cancelled'), usageDir(t), true);
  await exportSpend({ endpoint: 'https://otlp.example/', headers: 'Authorization=Bearer t', run, spend, fetchImpl });
  assert.deepEqual(
    sent.map((s) => s.url),
    ['https://otlp.example/v1/metrics', 'https://otlp.example/v1/logs'],
  );
  assert.equal(sent[0].headers.Authorization, 'Bearer t');
  const metrics = sent[0].body.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.deepEqual(
    metrics.map((m) => m.name),
    ['ai_review.tokens', 'ai_review.cost', 'ai_review.reviews', 'ai_review.unmeasured_calls'],
  );
  const costPoints = metrics[1].sum.dataPoints;
  const attrs = (p) => Object.fromEntries(p.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.deepEqual(
    costPoints.map((p) => [attrs(p)['ai_review.reviewer'], attrs(p)['ai_review.run.state'], p.asDouble.toFixed(2)]),
    [
      ['Claude', 'finished', '6.40'],
      ['Codex', 'cancelled', '3.00'],
    ],
  );
  assert.equal(attrs(costPoints[0])['vcs.change.id'], '7');
  const logs = sent[1].body.resourceLogs[0];
  assert.equal(logs.scopeLogs[0].logRecords.length, 2);
  assert.ok(logs.resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'gha-ai-review'));
});

test('the cost step records the round and exports it, and a refused export only warns', async (t) => {
  const dir = usageDir(t);
  Object.assign(process.env, { REVIEWS: needs('cancelled'), USAGE_OUTPUTS: dir, OTLP_ENDPOINT: 'http://127.0.0.1:9' });
  clearAfter(t, 'REVIEWS', 'USAGE_OUTPUTS', 'OTLP_ENDPOINT');
  const c = commentsClient();
  const k = core();
  // Port 9 refuses the connection.
  await cost({ github: c.github, context: context(), core: k });
  const [comment] = c.comments();
  const ledger = ledgerOf(comment);
  // The live head moved past the reviewed one, so the cancel was a push.
  assert.equal(ledger.rounds['9/1'].state, 'cancelled');
  assert.match(comment.body, /- Cancelled: ~\$9\.40 \(1 round\)/u);
  assert.equal(k.failures.length, 0);
  assert.match(k.warnings.at(-1), /Could not export the AI review cost/u);
});

test('the cost step records nothing when no review ran', async (t) => {
  Object.assign(process.env, { REVIEWS: needs('skipped'), USAGE_OUTPUTS: tempDir(t, 'usage-') });
  clearAfter(t, 'REVIEWS', 'USAGE_OUTPUTS');
  const c = commentsClient();
  const k = core();
  await cost({ github: c.github, context: context(), core: k });
  assert.deepEqual(c.calls, []);
  assert.match(k.notices[0], /No AI review ran/u);
});
