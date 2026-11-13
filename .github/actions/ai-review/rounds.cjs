'use strict';

const { roundsMarker } = require('./constants.cjs');
const { storedMarkerOf } = require('./decision.cjs');
const { summaryComment, livePull, verdictStatus } = require('./github.cjs');

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
// count nor hands the PR off; `counted` is then false. When the summary itself
// cannot be read, the record is undefined: publish then carries forward the
// one it finds when it writes the summary.
async function countRound({ github, context, core }, pull, state) {
  let record;
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

// Says the PR is a draft now; a later round reads it to tell whether this
// set's comment still says the review goes on.
const moved = 'so the AI review moved this PR back to draft';
const pausedLine = (drafted) =>
  drafted
    ? `${moved}, where it reviews no pushes, until you decide how to go on.`
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

// Whether this set's hand-off comment already says what is true, so a PR the
// review could not move to draft is asked once, not on every failing push. A
// conversion that succeeds after an earlier one failed is said again: the
// earlier comment says the review goes on.
async function alreadyAsked(github, context, number, since, drafted) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: number,
    per_page: 100,
  });
  const asked = comments.filter(
    (c) =>
      c.user?.login === 'github-actions[bot]' &&
      c.body?.startsWith(roundsMarker) &&
      Date.parse(c.created_at) >= Date.parse(since),
  );
  return drafted ? asked.some((c) => c.body.includes(moved)) : asked.length > 0;
}

// The live PR when it is still open, ready, at this head, and failing its
// verdict; otherwise null. A push since this review began is the newer head's
// to judge, and the author may have acted already, by drafting, closing, or
// overriding: an override accepted while this review published decided the
// head, and a ready_for_review after a hand-off would review it again and
// replace it. Like the other steps beside the verdict, a failed read only
// warns.
async function stillFailing({ github, context, core }, sha) {
  try {
    const pull = await livePull(github, context);
    if (pull.head.sha !== sha || pull.state !== 'open' || pull.draft) return null;
    return (await verdictStatus(github, context, sha))?.state === 'failure' ? pull : null;
  } catch (error) {
    core.warning(`Could not read the PR before handing it back to its author: ${error.message}`);
    return null;
  }
}

// GitHub refuses convertPullRequestToDraft to a GITHUB_TOKEN without
// contents: write, even with pull-requests: write. The verdict job's token has
// contents: read, so a caller that grants contents: write to a separate
// handoff job (see README.md) is the one whose PRs move to draft.
const draftPermission =
  'Converting a PR to draft takes a GITHUB_TOKEN with contents: write and pull-requests: write; run the handoff step in its own job with them (see README.md).';
const forbidden = (error) =>
  (Array.isArray(error.errors) && error.errors.some((e) => e?.type === 'FORBIDDEN')) ||
  /Resource not accessible by integration/u.test(error.message ?? '');

// Moves the PR to draft, which start() never reviews, and asks the author to
// re-assess the approach, once the PR and its verdict are read again. The
// conversion takes GraphQL; a failure only warns, and the comment then says
// the review goes on. Returns whether the PR moved to draft, or null when it
// was not handed off.
async function handOff({ github, context, core }, record) {
  const sha = context.payload.pull_request.head.sha;
  const pull = await stillFailing({ github, context, core }, sha);
  if (!pull) return null;
  let drafted = false;
  try {
    await github.graphql(
      'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      { id: pull.node_id },
    );
    drafted = true;
  } catch (error) {
    const why = forbidden(error) ? ` ${draftPermission}` : '';
    core.warning(`Could not move the PR back to draft after ${record.count} failing rounds: ${error.message}${why}`);
  }
  try {
    if (!(await alreadyAsked(github, context, pull.number, record.since, drafted))) {
      const body = handOffBody({ short: sha.slice(0, 7), count: record.count, drafted, author: authorOf(pull) });
      await github.rest.issues.createComment({ ...context.repo, issue_number: pull.number, body });
    }
  } catch (error) {
    core.warning(`Could not ask the author to re-assess the PR: ${error.message}`);
  }
  return drafted;
}

// The handoff step: hands the PR back to its author in a job of its own, whose
// token can convert it to draft, after publish recorded this head's round in
// the summary comment and set its hand-off output. A conversion that fails
// here fails the job, since its token was granted for nothing else.
async function handoff({ github, context, core }) {
  const pr = context.payload.pull_request;
  const record = storedRecord(await summaryComment(github, context, pr.number));
  if (record?.sha !== pr.head.sha || record.count < roundLimit) {
    core.info(
      `The summary records no failing round ${roundLimit} for ${pr.head.sha.slice(0, 7)}; nothing to hand off.`,
    );
    return;
  }
  if ((await handOff({ github, context, core }, record)) === false) {
    core.setFailed(`Could not move the PR back to draft after ${record.count} failing rounds. ${draftPermission}`);
  }
}

// Whether this round hands the PR back to its author: it was counted, it
// failed, and it reaches the limit.
const handsOff = (round, state) => round.counted && state === 'failure' && round.record.count >= roundLimit;

module.exports = { roundLimit, storedRecord, countRound, nextRounds, roundsLine, handOff, handsOff, handoff };
