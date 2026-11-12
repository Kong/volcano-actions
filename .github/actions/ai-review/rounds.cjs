'use strict';

const { roundsMarker } = require('./constants.cjs');
const { storedMarkerOf } = require('./decision.cjs');
const { summaryComment, livePull } = require('./github.cjs');

// The failing rounds in a row the AI review spends on a PR before its author
// decides how to go on. A review that keeps finding P0-P2 problems is not
// converging: more pushes would spend more reviews without the author's call
// on whether the findings stand, or whether to keep fixing, redesign, or split.
const roundLimit = 3;

// When the current set of rounds began: the last time the PR was marked ready
// for review or reopened, or else when it was opened. The review moves a PR
// that hits the limit back to draft, so marking it ready again starts a new
// set.
async function roundsSince(github, context, pull) {
  const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
    ...context.repo,
    issue_number: pull.number,
    per_page: 100,
  });
  const starts = events
    .filter((e) => ['ready_for_review', 'reopened'].includes(e.event) && typeof e.created_at === 'string')
    .map((e) => e.created_at);
  return starts.reduce((last, at) => (Date.parse(at) > Date.parse(last) ? at : last), pull.created_at);
}

// The rounds record the summary comment's marker holds, whatever its set, or
// null when it holds none.
function storedRecord(comment) {
  const rounds = storedMarkerOf(comment)?.rounds;
  const valid =
    typeof rounds?.since === 'string' &&
    Number.isInteger(rounds.count) &&
    rounds.count >= 0 &&
    (rounds.sha === null || typeof rounds.sha === 'string');
  return valid ? { since: rounds.since, count: rounds.count, sha: rounds.sha } : null;
}

// The record's count for the set that began at `since`; an earlier set's is none.
const storedCount = (record, since) => (record?.since === since ? record : { count: 0, sha: null });

// This review's place in the current set: the failing rounds in a row. A
// passing round has converged and resets the count. A review that did not
// complete is not a round, and a re-run of the head the last round failed
// repeats that round rather than adding one.
function nextRounds(stored, since, sha, state) {
  if (state === 'error') return { since, count: stored.count, sha: stored.sha };
  if (state !== 'failure') return { since, count: 0, sha };
  return { since, count: stored.sha === sha && stored.count > 0 ? stored.count : stored.count + 1, sha };
}

// Counts this review's round. When the timeline cannot be read, the summary's
// record carries forward unchanged, so a transient error neither resets the
// count nor hands the PR off; `counted` is then false.
async function countRound({ github, context, core }, pull, state) {
  let record = null;
  try {
    record = storedRecord(await summaryComment(github, context, pull.number));
    const since = await roundsSince(github, context, pull);
    return {
      record: nextRounds(storedCount(record, since), since, context.payload.pull_request.head.sha, state),
      counted: true,
    };
  } catch (error) {
    core.warning(`Could not count the AI review's rounds on this PR: ${error.message}`);
    return { record, counted: false };
  }
}

// The summary's line on the rounds, while the review still finds problems.
function roundsLine({ count }) {
  const since = 'since this PR was last marked ready for review';
  return count >= roundLimit
    ? `${count} rounds in a row have found P0-P2 problems ${since}, so the AI review asks the author to re-assess the approach.`
    : `Failing round ${count} of ${roundLimit} ${since}. If ${roundLimit} rounds in a row find P0-P2 problems, the AI review moves the PR back to draft for the author to re-assess the approach.`;
}

// Whom the hand-off asks: the author by name, so GitHub notifies them, unless
// a bot opened the PR, which a mention would not reach.
const authorOf = (pull) =>
  pull.user?.type === 'User' && /^[A-Za-z0-9-]+$/u.test(pull.user.login) ? `@${pull.user.login}` : 'PR author';

const pausedLine = (drafted) =>
  drafted
    ? 'so the AI review moved this PR back to draft, where it reviews no pushes, until you decide how to go on.'
    : 'but the AI review could not move this PR back to draft, so it keeps reviewing each push. Convert the PR to draft yourself while you decide how to go on.';

// The hand-off speaks to the author, and to a coding agent working for them,
// which reads PR comments: when fixes keep producing findings, the approach is
// usually the problem, and the agent must hand that call back to the author
// rather than push another fix.
const handOffBody = ({ short, count, drafted, author }) =>
  [
    roundsMarker,
    '### AI review: re-assess the approach',
    '',
    `${author}, the AI review has found P0-P2 problems in ${count} rounds in a row, through ${short}, since this PR was last marked ready for review. When each fix brings new findings, the approach is usually the problem rather than the next fix, ${pausedLine(drafted)}`,
    '',
    'Consider:',
    '- **Split it** into smaller PRs that each review cleanly.',
    '- **Simplify the design**, so there is less that can go wrong.',
    '- **Rethink the approach** where the findings keep landing in the same place.',
    '- **Push back** on findings you think are wrong: reply on each with a reason, or the follow-up work it waits for, and the next round reads it.',
    '',
    `**Coding agents:** stop here and do not push another fix for these findings. Tell the author this PR did not converge after ${count} AI review rounds, summarize the open findings and where they cluster, recommend one of the options above, and wait for the author's decision before changing the code or marking the PR ready for review.`,
    '',
    `Marking the PR ready for review starts a new set of ${roundLimit} rounds with a review of the current head. To accept the findings as they stand, mark it ready, and once that review finishes, add the \`ai-review-override\` label.`,
  ].join('\n');

// Whether this set's hand-off comment is already on the PR, so a PR the review
// could not move to draft is asked once, not on every failing push.
async function askedSince(github, context, number, since) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: number,
    per_page: 100,
  });
  return comments.some(
    (c) =>
      c.user?.login === 'github-actions[bot]' &&
      c.body?.startsWith(roundsMarker) &&
      Date.parse(c.created_at) >= Date.parse(since),
  );
}

// Moves the PR to draft, which start() never reviews, and asks the author to
// re-assess the approach. The PR is read again first: a push since this review
// began is the newer head's to judge, and the author may have acted already.
// The conversion takes GraphQL; a failure only warns, and the comment then
// says the review goes on.
async function handOff({ github, context, core }, record) {
  const sha = context.payload.pull_request.head.sha;
  const pull = await livePull(github, context);
  if (pull.head.sha !== sha || pull.state !== 'open' || pull.draft) return;
  let drafted = false;
  try {
    await github.graphql(
      'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      { id: pull.node_id },
    );
    drafted = true;
  } catch (error) {
    core.warning(`Could not move the PR back to draft after ${record.count} failing rounds: ${error.message}`);
  }
  try {
    if (await askedSince(github, context, pull.number, record.since)) return;
    const body = handOffBody({ short: sha.slice(0, 7), count: record.count, drafted, author: authorOf(pull) });
    await github.rest.issues.createComment({ ...context.repo, issue_number: pull.number, body });
  } catch (error) {
    core.warning(`Could not ask the author to re-assess the PR: ${error.message}`);
  }
}

// Whether this round hands the PR back to its author: it was counted, it
// failed, and it reaches the limit.
const handsOff = (round, state) => round.counted && state === 'failure' && round.record.count >= roundLimit;

module.exports = { roundLimit, countRound, nextRounds, roundsLine, handOff, handsOff };
