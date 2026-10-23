'use strict';

const { humanStatusContext } = require('./constants.cjs');
const { setStatus, verdictState, canWrite, livePull } = require('./github.cjs');

// Statuses of a run that has not finished, including one waiting on a
// concurrency group or an approval.
const unfinished = new Set(['requested', 'queued', 'pending', 'waiting', 'in_progress']);

// Cancels this workflow's runs that review a head the PR has moved past, whose
// verdicts nobody reads. Each head's runs share a concurrency group of their
// own (see ai-review.yml), so a push never cancels them by itself. start()
// calls this only from a run reviewing the PR's live head.
//
// A run for the live head must never be cancelled. GitHub does not create runs
// in event order, and the PR read can lag a push, so this cancels only runs
// created before its own, and only while the PR's head is still its own, read
// again after listing them. A run created later handles its own head: start()
// skips it when it is stale.
//
// Needs `actions: write`. Any failure leaves the stale runs to finish, as they
// would without this.
async function cancelSuperseded({ github, context, core }, pull) {
  const sha = context.payload.pull_request.head.sha;
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const { data: own } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: context.runId });
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: own.workflow_id,
    branch: pull.head.ref,
    event: 'pull_request_target',
    per_page: 100,
  });
  const stale = data.workflow_runs.filter(
    (run) =>
      run.id !== own.id &&
      unfinished.has(run.status) &&
      run.head_sha !== sha &&
      run.head_repository?.full_name === repo &&
      Date.parse(run.created_at) < Date.parse(own.created_at),
  );
  if (stale.length === 0) return;
  // The PR moved on while this run looked; the newer head's run cancels.
  if ((await livePull(github, context)).head.sha !== sha) return;
  for (const run of stale) {
    try {
      await github.rest.actions.cancelWorkflowRun({ ...context.repo, run_id: run.id });
      core.notice(`Cancelled run ${run.id}, which reviews ${run.head_sha.slice(0, 7)}, a head this PR has moved past.`);
    } catch (error) {
      // 409: the run finished first.
      if (error.status !== 409) core.warning(`Could not cancel run ${run.id}: ${error.message}`);
    }
  }
}

// Marks the live head as under review, so the gate is pending rather than
// absent and an override cannot pass it before the verdict lands, then cancels
// the reviews of heads the PR has moved past.
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
  try {
    await cancelSuperseded({ github, context, core }, pull);
  } catch (error) {
    core.warning(`Could not cancel the reviews of heads this PR has moved past: ${error.message}`);
  }
}

module.exports = { start };
