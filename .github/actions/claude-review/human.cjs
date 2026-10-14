'use strict';

const { statusContext, humanStatusContext, incomplete, approvedPrefix, fit } = require('./constants.cjs');
const { setStatus, verdictStatus, canWrite } = require('./github.cjs');

const isOtherUser = (r, pull) => r.user?.type === 'User' && r.user.login !== pull.user?.login;

// Each reviewer stands by their latest approval, change request, or
// dismissal; a later comment-only review leaves it in place, as GitHub counts
// it. Only people with write access count, and never the author. Each
// approver comes with the commit they approved.
async function standing(github, context, pull) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100,
  });
  const latest = new Map();
  for (const r of reviews) {
    if (isOtherUser(r, pull) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) {
      latest.set(r.user.login, r);
    }
  }
  const approvers = [];
  const blockers = [];
  for (const [login, r] of latest) {
    if (r.state === 'DISMISSED' || !(await canWrite(github, context, login))) continue;
    if (r.state === 'APPROVED') approvers.push({ login, commit: r.commit_id });
    else blockers.push(login);
  }
  const reviewed = reviews.some((r) => isOtherUser(r, pull));
  return { approvers, blockers, reviewed };
}

// When Claude's review of a head did not complete, an approval of that exact
// commit stands in for it, so an outage falls back to a person's review. An
// approval of an earlier commit does not: nobody would have read the rest.
// Withdrawing the approval restores the error. A verdict with findings is
// never replaced; it takes a fix or the override label. Both keep linking to
// the review's run, where a re-run reviews the commit again.
async function settleIncompleteReview(github, context, sha, approvers) {
  const status = await verdictStatus(github, context, sha);
  const here = approvers.filter((a) => a.commit === sha).map((a) => a.login);
  const approved = fit(`${approvedPrefix}${here.join(', ')}.`);
  const fallback = status?.state === 'success' && status.description?.startsWith(approvedPrefix);
  if (here.length > 0 && (status?.state === 'error' || (fallback && status.description !== approved))) {
    await setStatus(github, context, sha, 'success', approved, statusContext, status.target_url);
  } else if (fallback && here.length === 0) {
    await setStatus(github, context, sha, 'error', incomplete, statusContext, status.target_url);
  }
}

function humanState({ approvers, blockers }, reasons) {
  if (blockers.length > 0) return ['pending', `Changes requested by ${blockers.join(', ')}.`];
  if (approvers.length > 0) return ['success', `Approved by ${approvers.map((a) => a.login).join(', ')}.`];
  if (reasons.length > 0) return ['pending', `Needs human review: ${reasons[0]}`];
  return ['success', 'No human review needed.'];
}

// An approval carries across pushes, as it does under the repositories'
// required approvals today, none of which dismiss stale reviews.
async function setHumanStatus(github, context, pull, sha, reasons) {
  const reviews = await standing(github, context, pull);
  const [state, description] = humanState(reviews, reasons);
  await setStatus(github, context, sha, state, fit(description), humanStatusContext);
  await settleIncompleteReview(github, context, sha, reviews.approvers);
  return { waiting: state === 'pending' && reviews.blockers.length === 0 && !reviews.reviewed };
}

// Asks the suggested reviewer when the live head waits on its first human
// review and nobody has been asked by name yet; a team request, such as one
// from CODEOWNERS, does not count. Requesting a reviewer is a courtesy, so a
// failure only warns.
async function requestReviewer(github, context, core, pull, sha, { waiting }, reviewer) {
  if (
    !waiting ||
    !reviewer ||
    pull.state !== 'open' ||
    pull.draft ||
    pull.head.sha !== sha ||
    pull.requested_reviewers?.length > 0
  )
    return;
  try {
    await github.rest.pulls.requestReviewers({
      ...context.repo,
      pull_number: pull.number,
      reviewers: [reviewer.login],
    });
  } catch (error) {
    core.warning(`Could not request a review from ${reviewer.login}: ${error.message}`);
  }
}

module.exports = { setHumanStatus, requestReviewer };
