'use strict';

const { humanStatusContext } = require('./constants.cjs');
const { setStatus, verdictState, canWrite, livePull } = require('./github.cjs');

// Statuses of a run that has not finished, including one waiting on a
// concurrency group or an approval.
const unfinished = new Set(['requested', 'queued', 'pending', 'waiting', 'in_progress']);

// The reusable workflows a run calls, without their refs.
const calls = (run) => (run.referenced_workflows ?? []).map((w) => String(w.path).split('@')[0]);

// This run, and the other unfinished runs on the PR's branch in this
// repository that call the same review workflow, as both caller stubs do. A
// pull_request_target run's head_sha is the PR head it was triggered for, not
// the base, so it names the head each run reviews. Needs `actions: read`.
async function reviewRuns(github, context, pull) {
  const { data: own } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: context.runId });
  const review = calls(own).find((path) => path.endsWith('/.github/workflows/ai-review.yml'));
  if (!review) return { own, others: [] };
  const { data } = await github.rest.actions.listWorkflowRunsForRepo({
    ...context.repo,
    branch: pull.head.ref,
    event: 'pull_request_target',
    per_page: 100,
  });
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const others = data.workflow_runs.filter(
    (run) =>
      run.id !== own.id &&
      unfinished.has(run.status) &&
      run.head_repository?.full_name === repo &&
      calls(run).includes(review),
  );
  return { own, others };
}

const jobsOf = async (github, context, run) =>
  (await github.rest.actions.listJobsForWorkflowRun({ ...context.repo, run_id: run.id, per_page: 100 })).data.jobs;
// A called workflow's job is named for the caller's job, as in `ai-review / start`.
const ran = (jobs, name) => jobs.some((job) => job.name.endsWith(`/ ${name}`) && job.conclusion !== 'skipped');

// Whether a run is applying the ai-review-override label: its override job
// ran or will run. That job removes the label as it ends, so cancelling it
// would leave the label on the PR, where adding it again fires no event.
const overriding = async (github, context, run) => ran(await jobsOf(github, context, run), 'override');

// Cancels the review runs of heads the PR has moved past, whose verdicts
// nobody reads. Each head's runs share a concurrency group of their own (see
// ai-review.yml), so a push never cancels them by itself. start() calls this
// only from a run reviewing the PR's live head.
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
  const { own, others } = await reviewRuns(github, context, pull);
  const older = others.filter((run) => run.head_sha !== sha && Date.parse(run.created_at) < Date.parse(own.created_at));
  const stale = [];
  for (const run of older) if (!(await overriding(github, context, run))) stale.push(run);
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

// Whether a pending verdict was left by a review that no longer runs, such as
// one cancelled when the PR moved past its head, before the PR returned to it.
// A run of the head that skips start, such as an override, reviews nothing; one
// whose jobs are not listed yet may. When the runs cannot be listed, a review
// may still run.
async function abandoned(github, context, pull, sha) {
  try {
    const { others } = await reviewRuns(github, context, pull);
    for (const run of others.filter((r) => r.head_sha === sha)) {
      const jobs = await jobsOf(github, context, run);
      if (jobs.length === 0 || ran(jobs, 'start')) return false;
    }
    return true;
  } catch {
    return false;
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
    const left = state === 'pending' && (await abandoned(github, context, pull, sha));
    if (state !== 'none' && !left) return skip(`it already has a ${state} verdict.`);
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
