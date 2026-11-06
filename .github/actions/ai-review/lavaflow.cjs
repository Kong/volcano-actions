'use strict';

const { statusContext, lavaflowSkipped, lavaflowReason, fit, runUrl } = require('./constants.cjs');
const { setStatus, verdictStatus, isLavaFlowSkip, liveReasons } = require('./github.cjs');
const { setHumanStatus } = require('./human.cjs');

// LavaFlow opens fix PRs from one of Volcano's GitHub Apps and reviews each
// head it pushes, posting a COMMENT review from the same App pinned to that
// head by `commit_id`. At that head, and only there, its review stands in for
// the AI review. A person still has to approve.

// The Apps' bot logins, `<slug>[bot]`, from the lavaflow-apps input. They match
// exactly, never as a pattern, so a lookalike App cannot skip its review.
const lavaflowApps = () => (process.env.LAVAFLOW_APPS ?? '').split(/[\s,]+/u).filter(Boolean);
const isApp = (user, apps) => user?.type === 'Bot' && apps.includes(user.login);

// The PR author's review of `sha`, when one of the Apps opened the PR, or
// null. Only the review's commit ties it to the head: GitHub names web-flow
// as the committer of an App's commits, so a commit's identity proves nothing.
async function lavaflowReview(github, context, pull, sha) {
  if (!isApp(pull.user, lavaflowApps())) return null;
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100,
  });
  const own = (r) => r.user?.login === pull.user.login && r.user.type === 'Bot';
  return reviews.findLast((r) => own(r) && r.state === 'COMMENTED' && r.commit_id === sha) ?? null;
}

// A verdict the AI review reached. A re-run or a later event for the head
// reviews it again rather than replace that verdict with LavaFlow's.
const judged = (status) => Boolean(status) && status.state !== 'pending' && !isLavaFlowSkip(status);

// Passes the live head on LavaFlow's review instead of reviewing it, and says
// whether it did. ai-review/human waits for a person as for any other reason,
// and only their approval passes it. It goes first, so a failure cannot leave
// the verdict passing alone. Any error reviews the head as usual.
async function skipForLavaFlow({ github, context, core }, pull, sha) {
  const short = sha.slice(0, 7);
  try {
    const review = await lavaflowReview(github, context, pull, sha);
    if (!review) return false;
    if (judged(await verdictStatus(github, context, sha))) {
      core.notice(`${short} already has the AI review's verdict, so LavaFlow's review does not replace it.`);
      return false;
    }
    const reasons = [lavaflowReason(sha), ...(await liveReasons(github, context, pull, sha))];
    await setHumanStatus(github, context, pull, sha, [...new Set(reasons)]);
    const link = review.html_url ?? runUrl(context);
    await setStatus(github, context, sha, 'success', fit(lavaflowSkipped(sha, review.id)), statusContext, link);
    core.notice(
      `Skipping the review of ${short}: ${pull.user.login} opened the PR and reviewed it (review ${review.id}).`,
    );
    return true;
  } catch (error) {
    core.warning(`Could not pass ${short} on LavaFlow's review, so the AI review runs: ${error.message}`);
    return false;
  }
}

module.exports = { skipForLavaFlow };
