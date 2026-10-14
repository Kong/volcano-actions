'use strict';

const { humanStatusContext, overriddenBy, runUrl } = require('./constants.cjs');
const { verdict } = require('./verdict.cjs');
const { pathReasons } = require('./paths.cjs');
const { decisionMarker, humanSection, storedDecision } = require('./decision.cjs');
const {
  setStatus,
  removeOverrideLabel,
  summaryComment,
  verdictState,
  permissionOf,
  canWrite,
  livePull,
  isFork,
  liveReasons,
} = require('./github.cjs');
const { setHumanStatus, requestReviewer } = require('./human.cjs');
const { reviewerCandidates } = require('./candidates.cjs');
const { reviewersOf, completedReviews } = require('./reviews.cjs');
const { mergeReviews } = require('./merge.cjs');

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

// A re-run keeps its original event, so an older run would review obsolete
// code and overwrite the summary comment with a stale result.
async function isLiveHead(github, context) {
  return (await livePull(github, context)).head.sha === context.payload.pull_request.head.sha;
}

// Marks the live head as under review, so the gate is pending rather than
// absent and an override cannot pass it before the verdict lands.
async function start({ github, context, core }) {
  const sha = context.payload.pull_request.head.sha;
  const skip = (reason) => {
    core.notice(`Skipping the review of ${sha.slice(0, 7)}: ${reason}`);
    core.setOutput('review', 'false');
  };
  const pull = await livePull(github, context);
  if (pull.head.sha !== sha) return skip('it is no longer the PR head.');
  // A retarget keeps the head, so it shares the head's run group, and runs can
  // enter a group out of order. Compare the branch, which merges do not move.
  if (pull.base.ref !== context.payload.pull_request.base.ref)
    return skip('the PR has been retargeted since this event.');
  // The payload's draft flag can be stale: a push followed at once by
  // ready_for_review delivers a synchronize payload that still says draft.
  if (pull.draft) return skip('the PR is a draft.');
  // Reopening must not start a second review of a head already reviewed or
  // under review; a head pushed while the PR was closed has no verdict yet. A
  // re-run replays the reopen and finds its own first attempt's verdict.
  if (context.payload.action === 'reopened' && context.runAttempt === 1) {
    const state = await verdictState(github, context, sha);
    if (state !== 'none') return skip(`it already has a ${state} verdict.`);
  }
  // The action refuses users without write access (bots go through its
  // allowed_bots), which would replace this SHA's verdict with an error, for
  // example when a triage user reopens the PR.
  if (!context.actor.endsWith('[bot]') && !(await canWrite(github, context, context.actor))) {
    return skip(`${context.actor} lacks write access.`);
  }
  await setStatus(github, context, sha, 'pending', 'The AI review is running.');
  await setStatus(github, context, sha, 'pending', 'Waiting for the AI review.', humanStatusContext);
  core.setOutput('review', 'true');
}

// One summary comment per PR, edited in place, for the live head only: the
// statuses belong to the reviewed SHA, the summary to the live head.
async function publishSummary({ github, context, core }, result, decision) {
  const pr = context.payload.pull_request;
  try {
    if (!(await isLiveHead(github, context))) return;
    const body =
      result.state === 'error'
        ? `${result.body}\n\n${decisionMarker(pr.head.sha, decision)}`
        : `${result.body}${humanSection(pr.head.sha, decision)}`;
    const existing = await summaryComment(github, context, pr.number);
    if (existing) {
      await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
    } else {
      await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
    }
  } catch (error) {
    core.setFailed(`The verdict is published, but the summary comment failed: ${error.message}`);
  }
}

// Names each review that did not complete, which only the run log does, and
// fails the job only when none completed: otherwise the rest decide.
function reportIncomplete(core, sha, result) {
  const rest = result.state === 'error' ? '' : `, so the verdict rests on ${result.by}`;
  for (const name of result.missed) core.warning(`The ${name} review of ${sha.slice(0, 7)} did not complete${rest}.`);
  if (result.state === 'error') core.setFailed(`No AI review produced a verdict for ${sha}.`);
}

// Publishes the reviewer jobs' verdict: the commit statuses for the reviewed
// head, then the summary comment.
async function publish({ github, context, core }) {
  const pr = context.payload.pull_request;
  const pull = await livePull(github, context);
  if (pull.state !== 'open' && (await headReviewedElsewhere(github, context))) {
    core.notice(
      `Skipping the verdict for ${pr.head.sha.slice(0, 7)}: this PR is closed and another open PR has the same head.`,
    );
    return;
  }
  const { reviewers, candidates } = reviewersOf(process.env.REVIEWS);
  // The merge never throws: without one, the comment combines the reviews itself.
  const merged = await mergeReviews(completedReviews(reviewers), core);
  const result = verdict(reviewers, pr.head.sha, runUrl(context), reviewerCandidates(candidates), merged);
  // The status goes first so a failed comment cannot leave the head pending.
  await setStatus(github, context, pr.head.sha, result.state, result.description);
  reportIncomplete(core, pr.head.sha, result);
  // The review's own reasons, which the summary comment keeps; the live ones
  // are read again whenever the human status is set.
  const paths = await pathReasons(github, context, pr.number);
  const decision = { reasons: [...result.reasons, ...paths], reviewer: result.reviewer };
  let live = null;
  try {
    live = await liveReasons(github, context, pull, pr.head.sha);
    const gate = await setHumanStatus(github, context, pull, pr.head.sha, [...decision.reasons, ...live]);
    await requestReviewer(github, context, core, pull, pr.head.sha, gate, decision.reviewer);
  } catch (error) {
    core.setFailed(`The verdict is published, but the human review status failed: ${error.message}`);
  }
  // A reserved path or the needs-human-review label asks a person whatever
  // the reviews decide, so neither is theirs to clear; unread labels fail closed.
  decision.cleared = Boolean(result.cleared) && paths.length === 0 && live?.length === 0;
  await publishSummary({ github, context, core }, result, decision);
}

// Accepts the current head over a failing verdict, or a fork PR that is never
// reviewed. The label is a one-shot request: it is removed whether or not the
// override is accepted, so each commit needs its own.
async function override({ github, context, core }) {
  const { pull_request: pr, sender } = context.payload;
  const refuse = async (message) => {
    await removeOverrideLabel(github, context);
    core.setFailed(message);
  };

  // Labeling needs only triage access, so check write access here.
  const permission = await permissionOf(github, context, sender.login);
  if (sender.type !== 'User' || !['admin', 'write'].includes(permission)) {
    return refuse(
      `${sender.login} (${sender.type}, '${permission}' access) cannot override: it takes a human with write access.`,
    );
  }

  const fork = isFork(context, pr);
  const state = await verdictState(github, context, pr.head.sha);
  if (!fork && !['failure', 'error'].includes(state)) {
    return refuse(
      `${pr.head.sha.slice(0, 7)} has no failing verdict to override (status: ${state}). Add the label after the review finishes.`,
    );
  }

  // Accepting what the review says to fix is a judgment call, so the head now
  // needs a person other than the author as well. That status goes first, so
  // a failure leaves the verdict failing rather than both passing.
  const pull = await livePull(github, context);
  const stored = storedDecision(await summaryComment(github, context, pr.number), pr.head.sha);
  const reasons = [
    ...(stored?.reasons ?? []),
    overriddenBy(sender.login),
    ...(await liveReasons(github, context, pull, pr.head.sha)),
  ];
  const gate = await setHumanStatus(github, context, pull, pr.head.sha, [...new Set(reasons)]);
  await setStatus(github, context, pr.head.sha, 'success', overriddenBy(sender.login));
  await removeOverrideLabel(github, context);
  await requestReviewer(github, context, core, pull, pr.head.sha, gate, stored?.reviewer);
}

// The open PRs a gate event concerns. A review event's run lists only
// same-repository PRs, so look them up by head branch, which covers forks.
async function gatePulls(github, context) {
  if (context.eventName !== 'workflow_run') return [context.payload.pull_request.number];
  const run = context.payload.workflow_run;
  const { data } = await github.rest.pulls.list({
    ...context.repo,
    state: 'open',
    head: `${run.head_repository.owner.login}:${run.head_branch}`,
    per_page: 100,
  });
  return data.map((p) => p.number);
}

// Sets the live head's human status again after a review, a dismissal, or a
// change to the needs-human-review label. Runs from the base branch: a review
// event runs the PR's own copy of its workflow, so that run only triggers this.
async function gate({ github, context, core }) {
  for (const number of await gatePulls(github, context)) {
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    if (pull.state !== 'open') continue;
    const stored = storedDecision(await summaryComment(github, context, number), pull.head.sha);
    // Its review sets the status when it lands, reading the reviews then.
    if (!stored && !isFork(context, pull)) {
      core.notice(`Leaving ${pull.head.sha.slice(0, 7)} of #${number} to its review, which has not finished.`);
      continue;
    }
    const reasons = [...(stored?.reasons ?? []), ...(await liveReasons(github, context, pull, pull.head.sha))];
    const status = await setHumanStatus(github, context, pull, pull.head.sha, [...new Set(reasons)]);
    await requestReviewer(github, context, core, pull, pull.head.sha, status, stored?.reviewer);
  }
}

module.exports = { start, publish, override, gate };
