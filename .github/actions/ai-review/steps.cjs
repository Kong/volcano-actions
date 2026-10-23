'use strict';

const { overriddenBy, runUrl } = require('./constants.cjs');
const { verdict } = require('./verdict.cjs');
const { pathReasons } = require('./paths.cjs');
const { decisionMarker, humanSection, storedDecision } = require('./decision.cjs');
const {
  setStatus,
  removeOverrideLabel,
  summaryComment,
  verdictState,
  permissionOf,
  livePull,
  isFork,
  liveReasons,
  isLiveHead,
} = require('./github.cjs');
const { setHumanStatus, requestReviewer } = require('./human.cjs');
const { reviewerCandidates } = require('./candidates.cjs');
const { reviewersOf } = require('./reviews.cjs');
const { postFindings } = require('./findings.cjs');
const { start } = require('./start.cjs');

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

// Whether every deferred problem, given by its identity (see verdict.cjs), is
// one of the stored ones, counting repeats.
function covered(deferred, stored) {
  const left = [...stored];
  for (const key of deferred) {
    const i = left.indexOf(key);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

// When the summary of this head first reported its deferred problems. An
// approval before then cannot have decided them, even of this commit (see
// human.cjs). A re-run keeps the time only when it defers nothing the last
// review of this commit did not; a deferral that is new, moved, or reworded, or
// an unread summary, dates it now, which only asks for more.
async function deferredSince(github, context, sha, deferred) {
  if (deferred.length === 0) return null;
  try {
    const stored = storedDecision(await summaryComment(github, context, context.payload.pull_request.number), sha);
    return stored?.since && covered(deferred, stored.deferred) ? stored.since : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
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
// a reviewer when it waits.
async function settleHuman({ github, context, core }, pull, decision, live) {
  const sha = context.payload.pull_request.head.sha;
  try {
    const reasons = [...decision.reasons, ...live];
    const gate = await setHumanStatus(github, context, pull, sha, reasons, decision.since);
    await requestReviewer(github, context, core, pull, sha, gate, decision.reviewer);
  } catch (error) {
    core.setFailed(`The verdict is published, but the human review status failed: ${error.message}`);
  }
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
  // A job that failed has no output to read, but one that succeeded should.
  for (const reviewer of reviewers) {
    if (reviewer.result === 'success' && reviewer.unread) {
      core.warning(`Could not read the ${reviewer.name} review's output: ${reviewer.unread}`);
    }
  }
  const result = verdict(reviewers, pr.head.sha, runUrl(context), reviewerCandidates(candidates));
  // The status goes first so a failed comment cannot leave the head pending.
  await setStatus(github, context, pr.head.sha, result.state, result.description);
  reportIncomplete(core, pr.head.sha, result);
  // The review's own reasons, which the summary comment keeps; the live ones
  // are read again whenever the human status is set.
  const paths = await pathReasons(github, context, pr.number);
  const decision = {
    reasons: [...result.reasons, ...paths],
    reviewer: result.reviewer,
    deferred: result.deferred ?? [],
  };
  const live = await liveOrNull({ github, context, core }, pull);
  // A reserved path or the needs-human-review label asks a person whatever
  // the reviews decide, so neither is theirs to clear; unread labels fail closed.
  decision.cleared = Boolean(result.cleared) && paths.length === 0 && live?.length === 0;
  // Dated just before the summary reports a deferral, and the human status
  // follows it, so no approval given before a person could read it counts.
  decision.since = await deferredSince(github, context, pr.head.sha, decision.deferred);
  await publishSummary({ github, context, core }, result, decision);
  if (live) await settleHuman({ github, context, core }, pull, decision, live);
  await postFindings({ github, context, core }, reviewers);
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
  const gate = await setHumanStatus(github, context, pull, pr.head.sha, [...new Set(reasons)], stored?.since);
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
    const status = await setHumanStatus(github, context, pull, pull.head.sha, [...new Set(reasons)], stored?.since);
    await requestReviewer(github, context, core, pull, pull.head.sha, status, stored?.reviewer);
  }
}

module.exports = { start, publish, override, gate };
