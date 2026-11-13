'use strict';

// The PR's running review cost: one comment, edited in place, whose hidden
// ledger holds every review run's spend. Each run adds its own entry under its
// run ID and attempt, so writing an entry twice changes nothing.

const { costMarker } = require('./constants.cjs');

const ledgerPrefix = '<!-- ai-review-cost-ledger ';
// A comment holds at most 65,536 characters. Rounds past this many fold into
// one total per state, oldest first; their keys stay, so a late write of a
// folded round still changes nothing.
const keptRounds = 60;

const isCostComment = (comment) =>
  comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(costMarker);

async function costComments(github, context, number) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: number,
    per_page: 100,
  });
  return comments.filter((c) => isCostComment(c));
}

// The cost comments as they are now. Paging through a busy PR's comments
// can take longer than a read may be trusted, so the comments the listing
// found are read again, one request each. Null when one is gone: the writer
// that deleted it merged it into another, which this read may have seen
// before the merge.
async function fresh(github, context, found) {
  const comments = [];
  for (const { id } of found) {
    try {
      comments.push((await github.rest.issues.getComment({ ...context.repo, comment_id: id })).data);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
  return comments;
}

// Deletes a comment another writer may already have deleted.
async function deleteComment(github, context, id) {
  try {
    await github.rest.issues.deleteComment({ ...context.repo, comment_id: id });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

const emptySum = () => ({ cost: 0, rounds: 0, partial: false });
const emptyLedger = () => ({ rounds: {}, folded: { finished: emptySum(), cancelled: emptySum() }, seen: [] });

// The ledger a comment holds, or an empty one.
function ledgerOf(comment) {
  const encoded = comment?.body?.split(ledgerPrefix)[1]?.split(' -->')[0];
  if (!encoded) return emptyLedger();
  try {
    const ledger = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const empty = emptyLedger();
    return { ...empty, ...ledger, folded: { ...empty.folded, ...ledger.folded } };
  } catch {
    return emptyLedger();
  }
}

// A run's entry: its head, whether it finished, and each reviewer's cost.
// A run counts as cancelled when any of its reviewers was. Its cost is a
// lower bound when a reviewer stopped early or its cost is unknown; `stopped`
// names the reviewers that stopped early, whose own costs are lower bounds.
const roundOf = (sha, spend, at) => ({
  sha,
  at,
  state: spend.some((r) => r.state === 'cancelled') ? 'cancelled' : 'finished',
  partial: spend.some((r) => r.partial || !r.known),
  stopped: spend.filter((r) => r.partial).map((r) => r.reviewer),
  unknown: spend.filter((r) => !r.known).map((r) => r.reviewer),
  by: Object.fromEntries(spend.map((r) => [r.reviewer, Number(r.cost.toFixed(4))])),
});

const roundCost = (round) => Object.values(round.by).reduce((sum, cost) => sum + cost, 0);
const has = (ledger, key) => Object.hasOwn(ledger.rounds, key) || ledger.seen.includes(key);

// Folds the oldest rounds past `keptRounds` into each state's running total.
function fold(ledger) {
  for (const key of Object.keys(ledger.rounds).filter((k) => ledger.seen.includes(k))) delete ledger.rounds[key];
  const keys = Object.keys(ledger.rounds).toSorted((a, b) => ledger.rounds[a].at.localeCompare(ledger.rounds[b].at));
  for (const key of keys.slice(0, Math.max(keys.length - keptRounds, 0))) {
    const round = ledger.rounds[key];
    const sum = ledger.folded[round.state];
    sum.cost += roundCost(round);
    sum.rounds += 1;
    sum.partial ||= round.partial;
    ledger.seen.push(key);
    delete ledger.rounds[key];
  }
  return ledger;
}

const dollars = (amount, partial) => `${partial ? '~' : ''}$${amount.toFixed(2)}`;

// Each state's cost, round count, and whether any of it is a lower bound.
function totals(ledger) {
  const sums = { finished: { ...ledger.folded.finished }, cancelled: { ...ledger.folded.cancelled } };
  for (const round of Object.values(ledger.rounds)) {
    sums[round.state].cost += roundCost(round);
    sums[round.state].rounds += 1;
    sums[round.state].partial ||= round.partial;
  }
  return sums;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A reviewer's cost in a round: blank when it did not run, `?` when unknown,
// and a lower bound when it stopped early. A round written before `stopped`
// was recorded marks every reviewer as its total does.
function cell(round, name) {
  if (!(name in round.by)) return '';
  if (round.unknown?.includes(name)) return '?';
  return dollars(round.by[name], round.stopped?.includes(name) ?? round.partial);
}

// The recent rounds, newest first, as a table.
function roundsTable(ledger) {
  const rounds = Object.values(ledger.rounds).toSorted((a, b) => b.at.localeCompare(a.at));
  const reviewers = [...new Set(rounds.flatMap((r) => Object.keys(r.by)))].toSorted();
  return [
    `| Head | State | ${reviewers.join(' | ')} | Total |`,
    `|---|---|${reviewers.map(() => '---:').join('|')}|---:|`,
    ...rounds.map(
      (r) =>
        `| \`${r.sha.slice(0, 7)}\` | ${r.state} | ${reviewers.map((name) => cell(r, name)).join(' | ')} | ${dollars(roundCost(r), r.partial)} |`,
    ),
  ];
}

function costBody(full) {
  const ledger = fold(full);
  const sums = totals(ledger);
  const all = sums.finished.cost + sums.cancelled.cost;
  const rounds = sums.finished.rounds + sums.cancelled.rounds;
  const partial = sums.finished.partial || sums.cancelled.partial;
  return [
    costMarker,
    `**AI review cost:** ${dollars(all, partial)} over ${plural(rounds, 'round')}`,
    '',
    `- Finished: ${dollars(sums.finished.cost, sums.finished.partial)} (${plural(sums.finished.rounds, 'round')})`,
    `- Cancelled: ${dollars(sums.cancelled.cost, sums.cancelled.partial)} (${plural(sums.cancelled.rounds, 'round')}), stopped before they finished, usually by a newer push`,
    '',
    '<details><summary>By round</summary>',
    '',
    ...roundsTable(ledger),
    '',
    '</details>',
    '',
    "<sub>A reviewer on a plan with no per-token bill is priced at its tokens' API list price. ~ marks a lower bound: a review that stopped early, whose model call in flight then is not counted, or a reviewer whose cost is unknown (?) because it recorded no usage or its model has no listed price.</sub>",
    '',
    `${ledgerPrefix}${Buffer.from(JSON.stringify(ledger)).toString('base64')} -->`,
  ].join('\n');
}

// One ledger from several comments. Two comments exist only when two runs
// each found none and created one, before either folded a round, so their
// folded totals add without counting a round twice.
function merged(comments) {
  const ledger = emptyLedger();
  for (const comment of comments) {
    const other = ledgerOf(comment);
    Object.assign(ledger.rounds, other.rounds);
    ledger.seen = [...new Set([...ledger.seen, ...other.seen])];
    for (const state of ['finished', 'cancelled']) {
      const [sum, add] = [ledger.folded[state], other.folded[state]];
      ledger.folded[state] = {
        cost: sum.cost + add.cost,
        rounds: sum.rounds + add.rounds,
        partial: sum.partial || add.partial,
      };
    }
  }
  return ledger;
}

const pause = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// The action's client retries failed requests, and a retried write would land
// a copy of the ledger long after it was read. Ledger writes are never
// retried; the next round of `recordRound` reads again instead.
const once = { request: { retries: 0 } };

// Writes the ledger to the first cost comment, creating it if there is none,
// and deletes any other, folding them into it.
async function writeLedger(github, context, comments, ledger) {
  const body = costBody(ledger);
  const [first, ...rest] = comments;
  if (first) await github.rest.issues.updateComment({ ...context.repo, comment_id: first.id, body, ...once });
  else {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: context.payload.pull_request.number,
      body,
      ...once,
    });
  }
  for (const extra of rest) await deleteComment(github, context, extra.id);
}

// A writer that read the ledger longer ago than this reads it again rather
// than write a copy that may be stale.
const staleAfter = 3000;
// How long a writer waits before checking its round survived. GitHub stops
// processing an API request after 10 seconds, and ledger writes are never
// retried, so a write lands within `staleAfter` plus 10 seconds of its read.
// Any write from a read older than this writer's write has landed by then.
const settle = 20_000;

// Adds this run's round to the PR's cost comment. GitHub cannot update a
// comment only if it is unchanged, so two runs can write at once, as when a
// push cancels a review while another run records, and a later write can
// drop rounds an earlier one wrote, even rounds whose writers already saw
// them and stopped. Every writer writes only from a fresh read, once, waits
// until any write from an older read has landed, and reads again. It keeps
// every round it has seen, its own included, and writes again until all of
// them are there, so a round dropped after its writer stopped comes back
// through any writer still running that saw it. A round already recorded, as
// by a re-run of this step, is left as it is.
async function recordRound({ github, context }, key, round, timing = {}) {
  const { wait = pause, now = Date.now } = timing;
  const seen = { [key]: round };
  let failed;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const found = await costComments(github, context, context.payload.pull_request.number);
    const readAt = now();
    const comments = await fresh(github, context, found);
    if (!comments) continue;
    const ledger = merged(comments);
    const missing = Object.keys(seen).filter((k) => !has(ledger, k));
    Object.assign(seen, ledger.rounds);
    if (missing.length === 0 && comments.length === 1) return;
    for (const k of missing) ledger.rounds[k] = seen[k];
    if (now() - readAt <= staleAfter) {
      // A failed write may still have landed; the next read tells.
      try {
        await writeLedger(github, context, comments, ledger);
      } catch (error) {
        failed = error;
      }
    }
    await wait(settle);
  }
  throw new Error(`could not confirm round ${key} in the cost comment${failed ? `: ${failed.message}` : ''}`);
}

module.exports = { recordRound, roundOf, ledgerOf, costBody, totals, keptRounds };
