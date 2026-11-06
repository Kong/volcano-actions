'use strict';

// The events that re-set a reviewed head's human status and the review's own
// approval without another review: an override, and gate for reviews,
// dismissals, and the needs-human-review label.

const { overriddenBy, statusContext } = require('./constants.cjs');
const { storedDecision } = require('./decision.cjs');
const {
  setStatus,
  removeOverrideLabel,
  summaryComment,
  verdictState,
  verdictStatus,
  permissionOf,
  livePull,
  isFork,
  liveReasons,
} = require('./github.cjs');
const { setHumanStatus, requestReviewer } = require('./human.cjs');
const { unwithdrawn, withdrawBeforeVerdict, syncSelfApproval } = require('./self-approval.cjs');
const { ownerGroups } = require('./owners.cjs');
const { cutoff } = require('./deferral.cjs');

// Sets the human status of `sha` from the decision the summary recorded and
// the live reasons. A fork PR, which is never reviewed, records no decision,
// so its owners are found here.
async function restoreHuman({ github, context, core }, pull, sha, reasons, stored) {
  const owners = stored ? stored.owners : await ownerGroups({ github, context, core }, pull);
  return setHumanStatus(github, context, pull, sha, [...new Set(reasons)], cutoff(stored), owners);
}

// Withdraws every approval the review gave on a PR whose human status could
// not be set, or whose decision is missing, and fails the verdict when one
// stays, so a stale approval cannot carry the PR.
async function withdrawUnsettled({ github, context, core }, pull) {
  const sha = pull.head.sha;
  if (await withdrawBeforeVerdict({ github, context, core }, pull, sha)) return;
  const status = await verdictStatus(github, context, sha);
  await setStatus(github, context, sha, 'failure', unwithdrawn, statusContext, status?.target_url);
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
  const gate = await restoreHuman({ github, context, core }, pull, pr.head.sha, reasons, stored);
  // An approval that could not be withdrawn keeps the verdict failing.
  if (!(await syncSelfApproval({ github, context, core }, pull, pr.head.sha, gate, stored?.scope))) {
    await removeOverrideLabel(github, context);
    return;
  }
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
    // Its review sets the status when it lands, reading the reviews then. No
    // approval of the review's stands without a decision behind it.
    if (!stored && !isFork(context, pull)) {
      core.notice(`Leaving ${pull.head.sha.slice(0, 7)} of #${number} to its review, which has not finished.`);
      await withdrawUnsettled({ github, context, core }, pull);
      continue;
    }
    try {
      const reasons = [...(stored?.reasons ?? []), ...(await liveReasons(github, context, pull, pull.head.sha))];
      const status = await restoreHuman({ github, context, core }, pull, pull.head.sha, reasons, stored);
      await syncSelfApproval({ github, context, core }, pull, pull.head.sha, status, stored?.scope);
      await requestReviewer(github, context, core, pull, pull.head.sha, status, stored?.reviewer);
    } catch (error) {
      core.setFailed(`Could not re-set the human review status of #${number}: ${error.message}`);
      await withdrawUnsettled({ github, context, core }, pull);
    }
  }
}

module.exports = { override, gate };
