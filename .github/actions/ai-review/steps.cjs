'use strict';

const { overriddenBy, runUrl, severities, clean } = require('./constants.cjs');
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
} = require('./github.cjs');
const { setHumanStatus, requestReviewer } = require('./human.cjs');
const { reviewerCandidates } = require('./candidates.cjs');
const { reviewersOf, parsed, completed, cap, severityOf } = require('./reviews.cjs');
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

// A re-run keeps its original event, so an older run would review obsolete
// code and overwrite the summary comment with a stale result.
async function isLiveHead(github, context) {
  return (await livePull(github, context)).head.sha === context.payload.pull_request.head.sha;
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

// A finding's level and title, why it matters, and the model that found it.
// An older output, or a reviewer that omitted detail, still gets the rest.
function commentBody(f, signer) {
  const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
  return [
    `**${severities[severityOf(f)]}:** ${clean(cap(String(f.title), 200))}`,
    ...(detail ? [clean(cap(detail, 1500))] : []),
    `<sub>Found by ${clean(cap(signer, 100))}</sub>`,
  ].join('\n\n');
}

// Each completed review's findings on a line, as inline comments signed by
// the model that found them.
const inlineComments = (reviewers) =>
  parsed(reviewers)
    .filter((entry) => completed(entry.result, entry.review))
    .flatMap(({ name, model, review }) =>
      review.findings
        // The author already answered a deferred P2, and the summary lists it.
        .filter((f) => Number.isInteger(f.line) && f.line > 0 && !(severityOf(f) === 'p2' && f.deferred === true))
        .map((f) => ({ path: String(f.path), line: f.line, body: commentBody(f, model || name) })),
    );

// Posts the inline comments on the reviewed head while it is the live head;
// like the summary, a newer head's review comments for itself. Reviewers may
// comment on the same problem. A model's wording varies between runs, so a
// later push skips a line where this action already posted the same model's
// finding at the same level; comments by anyone else never count. Comments sit
// beside the verdict, so no failure here fails the job.
async function postFindings({ github, context, core }, reviewers) {
  const pr = context.payload.pull_request;
  const comments = [...new Map(inlineComments(reviewers).map((c) => [JSON.stringify(c), c])).values()];
  if (comments.length === 0) return;
  const lines = (body) => String(body).split('\n');
  const at = (c) => JSON.stringify([c.path, c.line, lines(c.body)[0].split(':**')[0], lines(c.body).at(-1)]);
  let posted;
  try {
    if (!(await isLiveHead(github, context))) {
      core.notice(`Skipped the inline comments on ${pr.head.sha.slice(0, 7)}, which is no longer the PR head.`);
      return;
    }
    const existing = await github.paginate(github.rest.pulls.listReviewComments, {
      ...context.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    posted = new Set(existing.filter((c) => c.user?.login === 'github-actions[bot]').map((c) => at(c)));
  } catch (error) {
    core.warning(`Could not read the PR's head or review comments, so none were posted: ${error.message}`);
    return;
  }
  for (const comment of comments) {
    if (posted.has(at(comment))) continue;
    try {
      await github.rest.pulls.createReviewComment({
        ...context.repo,
        pull_number: pr.number,
        commit_id: pr.head.sha,
        side: 'RIGHT',
        ...comment,
      });
    } catch (error) {
      const where = `${comment.path}:${comment.line}`;
      if (error.status === 422) core.notice(`Skipped the comment on ${where}, which is outside the diff.`);
      else core.warning(`Could not comment on ${where}: ${error.message}`);
    }
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
  const decision = { reasons: [...result.reasons, ...paths], reviewer: result.reviewer, exact: Boolean(result.exact) };
  let live = null;
  try {
    live = await liveReasons(github, context, pull, pr.head.sha);
    const reasons = [...decision.reasons, ...live];
    const gate = await setHumanStatus(github, context, pull, pr.head.sha, reasons, decision.exact);
    await requestReviewer(github, context, core, pull, pr.head.sha, gate, decision.reviewer);
  } catch (error) {
    core.setFailed(`The verdict is published, but the human review status failed: ${error.message}`);
  }
  // A reserved path or the needs-human-review label asks a person whatever
  // the reviews decide, so neither is theirs to clear; unread labels fail closed.
  decision.cleared = Boolean(result.cleared) && paths.length === 0 && live?.length === 0;
  await publishSummary({ github, context, core }, result, decision);
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
  const gate = await setHumanStatus(github, context, pull, pr.head.sha, [...new Set(reasons)], stored?.exact);
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
    const status = await setHumanStatus(github, context, pull, pull.head.sha, [...new Set(reasons)], stored?.exact);
    await requestReviewer(github, context, core, pull, pull.head.sha, status, stored?.reviewer);
  }
}

module.exports = { start, publish, override, gate };
