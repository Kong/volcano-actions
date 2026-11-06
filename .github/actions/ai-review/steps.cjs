'use strict';

const { runUrl } = require('./constants.cjs');
const { verdict } = require('./verdict.cjs');
const { pathReasons, authorReasons } = require('./paths.cjs');
const { flagReasons } = require('./flag-gates.cjs');
const { decisionMarker, humanSection } = require('./decision.cjs');
const { setStatus, summaryComment, livePull, liveReasons, isLiveHead } = require('./github.cjs');
const { setHumanStatus, requestReviewer } = require('./human.cjs');
const { unwithdrawn, scopeOf, namedReviewer, withdrawBeforeVerdict, syncSelfApproval } = require('./self-approval.cjs');
const { reviewerCandidates } = require('./candidates.cjs');
const { ownerGroups } = require('./owners.cjs');
const { reviewersOf } = require('./reviews.cjs');
const { postFindings } = require('./findings.cjs');
const { start } = require('./start.cjs');
const { override, gate } = require('./events.cjs');
const { keptSince, cutoff } = require('./deferral.cjs');

// A closed PR's late verdict must not replace the one for another open PR on
// the same head. Without one, it still publishes, so a reopen finds a verdict.
async function headReviewedElsewhere(github, context) {
  const pr = context.payload.pull_request;
  const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    ...context.repo,
    commit_sha: pr.head.sha,
  });
  return data.some((p) => p.number !== pr.number && p.state === 'open' && p.head.sha === pr.head.sha);
}

// The summary comment's body for a verdict and its decision.
function summaryBody(context, result, decision) {
  const { sha } = context.payload.pull_request.head;
  return result.state === 'error'
    ? `${result.body}\n\n${decisionMarker(sha, decision)}`
    : `${result.body}${humanSection(sha, decision)}`;
}

// One summary comment per PR, edited in place, for the live head only: the
// statuses belong to the reviewed SHA, the summary to the live head. Returns
// the comment as written, or null when it was not.
async function publishSummary({ github, context, core }, result, decision) {
  const pr = context.payload.pull_request;
  try {
    if (!(await isLiveHead(github, context))) return null;
    const body = summaryBody(context, result, decision);
    const existing = await summaryComment(github, context, pr.number);
    const { data } = existing
      ? await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body })
      : await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
    return data;
  } catch (error) {
    core.setFailed(`The verdict is published, but the summary comment failed: ${error.message}`);
    return null;
  }
}

// Dates a new deferral when GitHub recorded the summary that reports it, so no
// approval given before anyone could read it counts, and writes that time into
// the summary's marker. Returns the comment as written, or null when it was not.
async function dateDeferral({ github, context, core }, result, decision, written) {
  try {
    if (typeof written.updated_at !== 'string') throw new Error('GitHub did not say when it wrote the summary.');
    decision.since = written.updated_at;
    const body = summaryBody(context, result, decision);
    return (await github.rest.issues.updateComment({ ...context.repo, comment_id: written.id, body })).data;
  } catch (error) {
    core.setFailed(`The verdict is published, but the summary comment failed to date the deferral: ${error.message}`);
    return null;
  }
}

// Names each review that did not complete, which only the run log does, and
// fails the job only when none completed: otherwise the rest decide.
function reportIncomplete(core, sha, result) {
  const rest = result.state === 'error' ? '' : `, so the verdict rests on ${result.by}`;
  for (const name of result.missed) core.warning(`The ${name} review of ${sha.slice(0, 7)} did not complete${rest}.`);
  if (result.state === 'error') core.setFailed(`No AI review produced a verdict for ${sha}.`);
}

// The labels' reasons for a person, or null when they cannot be read, which
// fails the job and leaves the human status as start set it.
async function liveOrNull({ github, context, core }, pull) {
  try {
    return await liveReasons(github, context, pull, context.payload.pull_request.head.sha);
  } catch (error) {
    core.setFailed(`The verdict is published, but the human review status failed: ${error.message}`);
    return null;
  }
}

// Sets the human status, once the summary says what a person decides, and asks
// a reviewer when it waits. Says whether it set it and settled the review's
// own approval. Without a `written` summary, later events could not find the
// decision to withdraw an approval by, so the review gives none.
async function settleHuman({ github, context, core }, pull, decision, live, written) {
  const sha = context.payload.pull_request.head.sha;
  try {
    const reasons = [...decision.reasons, ...live];
    const gate = await setHumanStatus(github, context, pull, sha, reasons, cutoff(decision), decision.owners);
    const approvable = { ...gate, clear: gate.clear && Boolean(written) };
    const synced = await syncSelfApproval({ github, context, core }, pull, sha, approvable, decision.scope);
    await requestReviewer(github, context, core, pull, sha, gate, decision.reviewer);
    return synced;
  } catch (error) {
    core.setFailed(`The verdict is published, but the human review status failed: ${error.message}`);
    return false;
  }
}

// A job that failed has no output to read, but one that succeeded should.
function warnUnread(core, reviewers) {
  for (const reviewer of reviewers) {
    if (reviewer.result === 'success' && reviewer.unread) {
      core.warning(`Could not read the ${reviewer.name} review's output: ${reviewer.unread}`);
    }
  }
}

// A verdict that passes only because of a deferral fails until the summary
// records when the deferral was made, which later events read back, and the
// human status applies it.
const unrecorded = 'The summary does not record the deferred finding(s) yet. If this stays, re-run the review.';

// Sets the reviewed head's verdict, which fails while an approval the review
// gave could not be withdrawn; one that passes only because of a deferral is
// `held` failing until the deferral is recorded.
async function setVerdict({ github, context }, result, withdrawn) {
  const held = result.state === 'success' && result.deferred.length > 0;
  await setStatus(
    github,
    context,
    context.payload.pull_request.head.sha,
    !withdrawn || held ? 'failure' : result.state,
    withdrawn ? (held ? unrecorded : result.description) : unwithdrawn,
  );
  return held;
}

// Decides who must review the head and records it in the summary comment.
// Returns the decision, the live reasons, and the comment as written, or null.
async function recordDecision({ github, context, core }, pull, result, reviewers) {
  const pr = context.payload.pull_request;
  const { decision, paths } = await decisionOf({ github, context, core }, pull, result, reviewers);
  const live = await liveOrNull({ github, context, core }, pull);
  // A reserved path, an unverified flag check, or the needs-human-review label
  // asks a person whatever the reviews decide, so none is theirs to clear;
  // unread labels fail closed.
  decision.cleared = Boolean(result.cleared) && paths.length === 0 && live?.length === 0;
  decision.since = await keptSince(github, context, pr.head.sha, decision.deferred);
  let written = await publishSummary({ github, context, core }, result, decision);
  if (written && decision.deferred.length > 0 && !decision.since) {
    written = await dateDeferral({ github, context, core }, result, decision, written);
  }
  return { decision, live, written };
}

// The review's own reasons, which the summary comment keeps, with who to ask
// and whose approval counts; the live ones are read again whenever the human
// status is set. `paths` are the reasons no review can clear.
async function decisionOf({ github, context, core }, pull, result, reviewers) {
  const pr = context.payload.pull_request;
  const paths = [
    ...authorReasons(pr.user),
    ...(await pathReasons(github, context, pr.number, pr.user.login)),
    // A clearing behind a feature flag holds only on checks publish verifies.
    ...(result.reasons.length === 0 ? await flagReasons({ github, context }, reviewers) : []),
  ];
  const decision = {
    reasons: [...result.reasons, ...paths],
    reviewer: namedReviewer(pr.user) ?? result.reviewer,
    deferred: result.deferred ?? [],
    scope: scopeOf(pr.user),
    owners: await ownerGroups({ github, context, core }, pull),
  };
  return { decision, paths };
}

// Publishes the reviewer jobs' verdict: the commit statuses for the reviewed
// head, then the summary comment, then each review's inline comments.
async function publish({ github, context, core }) {
  const pr = context.payload.pull_request;
  const { reviewers, candidates } = reviewersOf(process.env.REVIEWS, process.env.REVIEW_OUTPUTS);
  // A job-level `if` sees every ancestor's result in `needs`, so start's
  // success runs this job when start skipped the review or the run was
  // cancelled. The head keeps whatever status start left it.
  if (reviewers.length > 0 && reviewers.every((r) => ['skipped', 'cancelled'].includes(r.result))) {
    core.notice(`Publishing no verdict for ${pr.head.sha.slice(0, 7)}: every AI review was skipped or cancelled.`);
    return;
  }
  const pull = await livePull(github, context);
  if (pull.state !== 'open' && (await headReviewedElsewhere(github, context))) {
    core.notice(
      `Skipping the verdict for ${pr.head.sha.slice(0, 7)}: this PR is closed and another open PR has the same head.`,
    );
    return;
  }
  warnUnread(core, reviewers);
  const result = verdict(reviewers, pr.head.sha, runUrl(context), reviewerCandidates(candidates));
  // The approvals the review gave go before anything passes. The summary then
  // records the new decision while start's pending verdict still holds the
  // head, so a gate run never pairs a passing verdict with an earlier review's
  // decision. The verdict is set whatever the summary does.
  const withdrawn = await withdrawBeforeVerdict({ github, context, core }, pull, pr.head.sha);
  let recorded = null;
  let held = false;
  try {
    recorded = await recordDecision({ github, context, core }, pull, result, reviewers);
  } finally {
    held = await setVerdict({ github, context }, result, withdrawn);
  }
  reportIncomplete(core, pr.head.sha, result);
  const { decision, live, written } = recorded;
  const settled = live !== null && (await settleHuman({ github, context, core }, pull, decision, live, written));
  if (held && written && settled && withdrawn)
    await setStatus(github, context, pr.head.sha, 'success', result.description);
  await postFindings({ github, context, core }, reviewers);
}

module.exports = { start, publish, override, gate };
