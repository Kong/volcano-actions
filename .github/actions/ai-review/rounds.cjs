'use strict';

const { roundsMarker } = require('./constants.cjs');
const { storedMarkerOf } = require('./decision.cjs');
const { summaryComment } = require('./github.cjs');

// The rounds the AI review spends on a PR before a person decides how to go
// on. A review that still finds P0-P2 problems after this many rounds is not
// converging: more pushes would spend more reviews without a person's call on
// whether the findings stand, or whether to keep fixing, redesign, or split.
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

// The rounds the summary comment records for the set that began at `since`,
// or none when it records an earlier set or none at all.
function storedCount(comment, since) {
  const rounds = storedMarkerOf(comment)?.rounds;
  if (rounds?.since !== since || !Number.isInteger(rounds.count) || rounds.count < 0) return { count: 0, sha: null };
  return { count: rounds.count, sha: typeof rounds.sha === 'string' ? rounds.sha : null };
}

// This review's place in the current set of rounds. A review that did not
// complete is not a round, and a re-run of the head the last round reviewed
// repeats that round rather than adding one.
function nextRounds(stored, since, sha, completed) {
  if (!completed) return { since, count: stored.count, sha: stored.sha };
  return { since, count: stored.sha === sha ? stored.count : stored.count + 1, sha };
}

// Counts this review's round, or returns null when the timeline or summary
// cannot be read, which leaves the PR to the reviews as before.
async function countRound({ github, context, core }, pull, completed) {
  try {
    const since = await roundsSince(github, context, pull);
    const comment = await summaryComment(github, context, pull.number);
    return nextRounds(storedCount(comment, since), since, context.payload.pull_request.head.sha, completed);
  } catch (error) {
    core.warning(`Could not count the AI review's rounds on this PR: ${error.message}`);
    return null;
  }
}

// The summary's line on the rounds, while the review still finds problems.
function roundsLine({ count }) {
  const round = `Round ${count} of ${roundLimit} since this PR was last marked ready for review`;
  return count >= roundLimit
    ? `${round}, so the author re-assesses the approach before the AI review reviews more pushes.`
    : `${round}. If round ${roundLimit} still finds P0-P2 problems, the AI review moves the PR back to draft for the author to re-assess the approach.`;
}

// Whom the hand-off asks: the author by name, so GitHub notifies them, unless
// a bot opened the PR, which a mention would not reach.
const authorOf = (pull) =>
  pull.user?.type === 'User' && /^[A-Za-z0-9-]+$/u.test(pull.user.login) ? `@${pull.user.login}` : 'PR author';

// The hand-off speaks to the author, and to a coding agent working for them,
// which reads PR comments: when fixes keep producing findings, the approach is
// usually the problem, and the agent must hand that call back to the author
// rather than push another fix.
const handOffBody = (short, drafted, author) =>
  [
    roundsMarker,
    '### AI review: re-assess the approach',
    '',
    `${author}, the AI review still finds P0-P2 problems at ${short} after ${roundLimit} rounds since this PR was last marked ready for review. When each fix brings new findings, the approach is usually the problem rather than the next fix, so ${drafted ? 'the AI review moved this PR back to draft and' : 'the AI review'} will not review more pushes until you decide how to go on.${drafted ? '' : ' It could not move the PR back to draft, so convert it yourself while you decide.'}`,
    '',
    'Consider:',
    '- **Split it** into smaller PRs that each review cleanly.',
    '- **Simplify the design**, so there is less that can go wrong.',
    '- **Rethink the approach** where the findings keep landing in the same place.',
    '- **Push back** on findings you think are wrong: reply on each with a reason, or the follow-up work it waits for, and the next round reads it.',
    '',
    `**Coding agents:** stop here and do not push another fix for these findings. Tell the author this PR did not converge after ${roundLimit} AI review rounds, summarize the open findings and where they cluster, recommend one of the options above, and wait for the author's decision before changing the code or marking the PR ready for review.`,
    '',
    `Marking the PR ready for review starts a new set of ${roundLimit} rounds.`,
  ].join('\n');

// Moves the PR to draft, which start() never reviews, and asks the author to
// re-assess the approach. The conversion takes GraphQL; a failure only warns, and the
// comment then still asks.
async function handOff({ github, context, core }, pull) {
  const short = context.payload.pull_request.head.sha.slice(0, 7);
  let drafted = false;
  try {
    await github.graphql(
      'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      { id: pull.node_id },
    );
    drafted = true;
  } catch (error) {
    core.warning(`Could not move the PR back to draft after ${roundLimit} rounds: ${error.message}`);
  }
  try {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: pull.number,
      body: handOffBody(short, drafted, authorOf(pull)),
    });
  } catch (error) {
    core.warning(`Could not ask the author to re-assess the PR after ${roundLimit} rounds: ${error.message}`);
  }
}

// Whether this round hands the PR back to its author: it failed, it is at least the
// last round, and the PR is still open and ready for review.
const handsOff = (rounds, state, pull) =>
  rounds !== null && state === 'failure' && rounds.count >= roundLimit && pull.state === 'open' && !pull.draft;

module.exports = { roundLimit, countRound, nextRounds, roundsLine, handOff, handsOff };
