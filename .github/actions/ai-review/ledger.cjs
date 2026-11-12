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
// lower bound when a reviewer stopped early or its cost is unknown.
const roundOf = (sha, spend, at) => ({
  sha,
  at,
  state: spend.some((r) => r.state === 'cancelled') ? 'cancelled' : 'finished',
  partial: spend.some((r) => r.partial || !r.known),
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

// A reviewer's cost in a round: blank when it did not run, `?` when unknown.
function cell(round, name) {
  if (!(name in round.by)) return '';
  return round.unknown?.includes(name) ? '?' : dollars(round.by[name], round.partial);
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
    "<sub>A reviewer on a plan with no per-token bill, such as Codex on a ChatGPT workspace, is priced at its tokens' API list price. ~ marks a lower bound: a review that stopped early, whose model call in flight then is not counted, or a reviewer whose cost is unknown (?) because it recorded no usage or its model has no listed price.</sub>",
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

// Writes the ledger to the first cost comment, creating it if there is none,
// and deletes any other, folding them into it.
async function writeLedger(github, context, comments, ledger) {
  const body = costBody(ledger);
  const [first, ...rest] = comments;
  if (first) await github.rest.issues.updateComment({ ...context.repo, comment_id: first.id, body });
  else {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: context.payload.pull_request.number,
      body,
    });
  }
  for (const extra of rest) await github.rest.issues.deleteComment({ ...context.repo, comment_id: extra.id });
}

// A writer that read the ledger longer ago than this reads it again rather
// than write a copy that may be stale.
const staleAfter = 3000;
// How long a writer waits before checking its round survived. It exceeds
// `staleAfter` plus a write's latency, so any write made from a read that
// predates this writer's has landed by then.
const settle = 10_000;

// Adds this run's round to the PR's cost comment. GitHub cannot update a
// comment only if it is unchanged, so two runs can write at once, as when a
// push cancels a review while another run records, and the later write can
// drop the earlier one's round. Every writer writes only from a fresh read,
// waits until any write from an older read has landed, and reads again,
// writing again until its round is there. A round already recorded, as by a
// re-run of this step, is left as it is.
async function recordRound({ github, context }, key, round, timing = {}) {
  const { wait = pause, now = Date.now } = timing;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const readAt = now();
    const comments = await costComments(github, context, context.payload.pull_request.number);
    const ledger = merged(comments);
    if (has(ledger, key) && comments.length === 1) return;
    if (!has(ledger, key)) ledger.rounds[key] = round;
    if (now() - readAt <= staleAfter) await writeLedger(github, context, comments, ledger);
    await wait(settle);
  }
  throw new Error(`could not confirm round ${key} in the cost comment`);
}

module.exports = { recordRound, roundOf, ledgerOf, costBody, totals, keptRounds };
