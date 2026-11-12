'use strict';

// The PR's running review cost: one comment, edited in place, whose hidden
// ledger holds every review run's spend. Each run adds its own entry under its
// run ID and attempt, so writing an entry twice changes nothing.

const { costMarker } = require('./constants.cjs');

const ledgerPrefix = '<!-- ai-review-cost-ledger ';
// A comment holds at most 65,536 characters. Rounds past this many fold into
// one total, oldest first.
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

const emptyLedger = () => ({ rounds: {}, folded: { finished: [0, 0], cancelled: [0, 0], partial: false } });

// The ledger a comment holds, or an empty one.
function ledgerOf(comment) {
  const encoded = comment?.body?.split(ledgerPrefix)[1]?.split(' -->')[0];
  if (!encoded) return emptyLedger();
  try {
    const ledger = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    return { ...emptyLedger(), ...ledger };
  } catch {
    return emptyLedger();
  }
}

// A run's entry: its head, whether it finished, and each reviewer's cost.
// A run counts as cancelled when any of its reviewers was.
const roundOf = (sha, spend, at) => ({
  sha,
  at,
  state: spend.some((r) => r.state === 'cancelled') ? 'cancelled' : 'finished',
  partial: spend.some((r) => r.partial),
  by: Object.fromEntries(spend.map((r) => [r.reviewer, Number(r.cost.toFixed(4))])),
});

const roundCost = (round) => Object.values(round.by).reduce((sum, cost) => sum + cost, 0);

// Folds the oldest rounds past `keptRounds` into the ledger's running total.
function fold(ledger) {
  const keys = Object.keys(ledger.rounds).toSorted((a, b) => ledger.rounds[a].at.localeCompare(ledger.rounds[b].at));
  for (const key of keys.slice(0, Math.max(keys.length - keptRounds, 0))) {
    const round = ledger.rounds[key];
    ledger.folded[round.state][0] += roundCost(round);
    ledger.folded[round.state][1] += 1;
    ledger.folded.partial ||= round.partial;
    delete ledger.rounds[key];
  }
  return ledger;
}

const dollars = (amount, partial) => `${partial ? '~' : ''}$${amount.toFixed(2)}`;

// Each state's cost, round count, and whether any of it is a lower bound.
function totals(ledger) {
  const sums = {
    finished: { cost: ledger.folded.finished[0], rounds: ledger.folded.finished[1], partial: false },
    cancelled: { cost: ledger.folded.cancelled[0], rounds: ledger.folded.cancelled[1], partial: ledger.folded.partial },
  };
  for (const round of Object.values(ledger.rounds)) {
    sums[round.state].cost += roundCost(round);
    sums[round.state].rounds += 1;
    sums[round.state].partial ||= round.partial;
  }
  return sums;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The recent rounds, newest first, as a table.
function roundsTable(ledger) {
  const rounds = Object.values(ledger.rounds).toSorted((a, b) => b.at.localeCompare(a.at));
  const reviewers = [...new Set(rounds.flatMap((r) => Object.keys(r.by)))].toSorted();
  return [
    `| Head | State | ${reviewers.join(' | ')} | Total |`,
    `|---|---|${reviewers.map(() => '---:').join('|')}|---:|`,
    ...rounds.map(
      (r) =>
        `| \`${r.sha.slice(0, 7)}\` | ${r.state} | ${reviewers.map((name) => (name in r.by ? dollars(r.by[name], r.partial) : '')).join(' | ')} | ${dollars(roundCost(r), r.partial)} |`,
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
    "<sub>A reviewer on a plan with no per-token bill, such as Codex on a ChatGPT workspace, is priced at its tokens' API list price. ~ marks a review that stopped early, whose model call in flight then is not counted.</sub>",
    '',
    `${ledgerPrefix}${Buffer.from(JSON.stringify(ledger)).toString('base64')} -->`,
  ].join('\n');
}

// One ledger from several comments, as when two runs each created one.
function merged(comments) {
  const ledger = emptyLedger();
  for (const comment of comments) {
    const other = ledgerOf(comment);
    Object.assign(ledger.rounds, other.rounds);
    for (const state of ['finished', 'cancelled']) {
      ledger.folded[state] = ledger.folded[state].map((n, i) => n + other.folded[state][i]);
    }
    ledger.folded.partial ||= other.folded.partial;
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

// Adds this run's round to the PR's cost comment. Two runs can write it at
// once, as when a push cancels a review while another run records, so after
// writing it reads the comment back and merges again when its round is gone.
async function recordRound({ github, context }, key, round, wait = pause) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const comments = await costComments(github, context, context.payload.pull_request.number);
    const ledger = merged(comments);
    if (attempt > 0 && ledger.rounds[key] && comments.length === 1) return;
    ledger.rounds[key] = round;
    await writeLedger(github, context, comments, ledger);
    await wait(500 + Math.random() * 1500);
  }
}

module.exports = { recordRound, roundOf, ledgerOf, costBody, totals, keptRounds };
