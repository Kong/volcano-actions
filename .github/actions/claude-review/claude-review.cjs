'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Runs in actions/github-script from a pinned trusted revision, never from the PR,
// so a PR cannot change how its review is judged. See action.yml.
const statusContext = 'claude-review/verdict';
// Whether the head still needs a person's review: it passes when nothing calls
// for one, or once a collaborator with write access other than the author
// approves. Repositories that require it can drop their required approvals.
const humanStatusContext = 'claude-review/human';
const overrideLabel = 'claude-review-override';
const humanLabel = 'needs-human-review';
const marker = '<!-- claude-review-verdict -->';
// Severity levels, most severe first: Codex review's P0-P3 priorities, plus
// pre-existing problems the PR did not cause.
const severities = { p0: '🔴 P0', p1: '🟠 P1', p2: '🟡 P2', p3: '⚪ P3', pre_existing: '🟣 Pre-existing' };
const failing = ['p0', 'p1', 'p2'];

const runUrl = (context) =>
  `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
const overridePrefix = 'Failing verdict overridden by ';
const overriddenBy = (login) => `${overridePrefix}${login}.`;
const incomplete = 'Review did not complete. Re-run it, or have a writer approve this commit.';
const approvedPrefix = 'Review did not complete; approved by ';
// Commit status descriptions are capped at 140 characters.
const fit = (text) => (text.length <= 140 ? text : `${text.slice(0, 139)}…`);

async function setStatus(github, context, sha, state, description, name = statusContext, targetUrl = runUrl(context)) {
  await github.rest.repos.createCommitStatus({
    ...context.repo,
    sha,
    state,
    context: name,
    description,
    target_url: targetUrl,
  });
}

async function removeOverrideLabel(github, context) {
  try {
    await github.rest.issues.removeLabel({
      ...context.repo,
      issue_number: context.payload.pull_request.number,
      name: overrideLabel,
    });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

// Breaks @mentions and inline code spans so finding text cannot ping people or
// escape its formatting.
const clean = (text) => String(text).replace(/@/g, '@​');
const code = (text) => `\`${String(text).replace(/`/g, "'")}\``;

// Anything but an explicit `needed: false` asks for a person, so a missing or
// malformed decision fails closed without discarding the findings.
function humanReasons(review) {
  const decision = review?.human_review;
  if (decision?.needed === false) return [];
  const reasons = ownReasons(review);
  if (reasons.length) return reasons;
  return [
    decision?.needed === true
      ? 'Claude asked for a human review.'
      : 'Claude did not say whether this needs a human review.',
  ];
}

const ownReasons = (review) =>
  (Array.isArray(review?.human_review?.reasons) ? review.human_review.reasons : [])
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => r.trim())
    .slice(0, 5);

// Whether the comment may tell a person the code needs no second look: nothing
// blocks, Claude says it read the whole change closely, and it asked for a
// person with reasons of its own. Anything else fails closed.
const clearsCode = (review, blocking) =>
  !blocking.length &&
  review.reviewed_closely === true &&
  review.human_review?.needed === true &&
  ownReasons(review).length > 0;

// Says what the review could not verify, so a person checks only that. The
// first line holds while the review job allows Claude only Read, Grep, Glob,
// and inline comments; the workflow test pins that tool list.
function notChecked(review) {
  const items = (Array.isArray(review?.not_checked) ? review.not_checked : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => `- ${clean(n.trim())}`)
    .slice(0, 5);
  return [
    "**Not checked:** Claude read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.",
    ...items,
  ];
}

// Claude's pick when it is one of the candidates the workflow found, so the
// PR cannot steer the request; otherwise the candidate with the most history
// in the changed files.
function suggestedReviewer(review, candidates) {
  const decision = review?.human_review;
  const pick = typeof decision?.reviewer === 'string' ? decision.reviewer.trim().replace(/^@/, '').toLowerCase() : '';
  const login = candidates.find((c) => c.toLowerCase() === pick);
  if (login) {
    const why = typeof decision.reviewer_reason === 'string' ? decision.reviewer_reason.trim().slice(0, 200) : '';
    return { login, why: why || 'Claude suggested them' };
  }
  return candidates.length ? { login: candidates[0], why: 'most recent history in the changed files' } : null;
}

// Turns the review job's result and structured output into a status and
// comment, the reasons, if any, that the head needs a person's review, and
// who to ask for it.
function verdict(result, output, sha, url, candidates = []) {
  let review = null;
  try {
    review = JSON.parse(output);
  } catch {}
  const short = sha.slice(0, 7);
  // Structured output may vary an enum's case, so normalize it, and treat any
  // other severity as an incomplete review rather than a passing one.
  const severity = (f) =>
    String(f?.severity)
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
  if (
    result !== 'success' ||
    typeof review?.summary !== 'string' ||
    !Array.isArray(review?.findings) ||
    !review.findings.every((f) => Object.hasOwn(severities, severity(f)))
  ) {
    // The summary must not keep showing an earlier head's verdict.
    return {
      state: 'error',
      description: incomplete,
      body: [
        marker,
        '### Claude review: did not complete',
        '',
        `Reviewing ${short} failed. [Run log](${url})`,
        '',
        `Re-run all jobs in that run, or have a collaborator with write access other than the author approve ${short}, which stands in for the review.`,
      ].join('\n'),
      reasons: ['The Claude review did not complete.'],
      reviewer: suggestedReviewer(null, candidates),
    };
  }

  const at = (level) => review.findings.filter((f) => severity(f) === level);
  const blocking = review.findings.filter((f) => failing.includes(severity(f)));
  const item = (f) => `- ${code(f.line > 0 ? `${f.path}:${f.line}` : f.path)} ${clean(f.title)}`;
  const body = [
    marker,
    blocking.length ? `### Claude review: ${blocking.length} P0-P2 finding(s)` : '### Claude review: no P0-P2 findings',
    '',
    `Reviewed ${short}. [Run log](${url})`,
    '',
    clean(review.summary),
  ];
  for (const [level, label] of Object.entries(severities)) {
    if (at(level).length) body.push('', `**${label}**`, ...at(level).map(item));
  }
  body.push('', ...notChecked(review));
  const reasons = humanReasons(review);
  const reviewer = suggestedReviewer(review, candidates);
  if (blocking.length) {
    body.push(
      '',
      `Push a fix, or have a collaborator with write access (including the PR author) add the \`${overrideLabel}\` label to accept ${short} as is. An override also needs a human review.`,
    );
    return {
      state: 'failure',
      description: `${blocking.length} P0-P2 finding(s). See the Claude review comment.`,
      body: body.join('\n'),
      reasons,
      reviewer,
    };
  }
  return {
    state: 'success',
    description: `No P0-P2 findings (${at('p3').length} P3, ${at('pre_existing').length} pre-existing).`,
    body: body.join('\n'),
    reasons,
    reviewer,
    cleared: clearsCode(review, blocking),
  };
}

// Matches a repository-relative path against a glob: `*` and `?` stay within
// one directory, `**/` spans any number of them, and a final `**` matches the rest.
function globRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      pattern += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      pattern += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      pattern += '[^/]*';
    } else if (glob[i] === '?') {
      pattern += '[^/]';
    } else {
      pattern += glob[i].replace(/[\\^$.|+(){}[\]]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

// Reasons from the paths a repository reserves for a person, which no PR text
// can argue away. Every other change is Claude's call. A rename counts at both
// its old and new path. GitHub lists at most 3000 files, so a larger PR cannot
// be checked in full.
async function pathReasons(github, context, number) {
  const own = (process.env.HUMAN_REVIEW_PATHS || '')
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'));
  if (!own.length) return [];
  let files;
  try {
    files = await github.paginate(github.rest.pulls.listFiles, { ...context.repo, pull_number: number, per_page: 100 });
  } catch {
    return ['Could not list the changed files to check them for paths that need a human review.'];
  }
  if (files.length >= 3000) return ['Changes more files than GitHub lists, so not every path could be checked.'];
  const changed = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean))];
  const reserved = changed.filter((file) => own.some((p) => globRegExp(p).test(file)));
  if (!reserved.length) return [];
  const more = reserved.length > 1 ? ` (+${reserved.length - 1} more)` : '';
  return [`Changes a path this repository reserves for human review: ${reserved[0]}${more}.`];
}

// The summary comment records the review's reasons for its head and who to
// ask, so later events can re-set the human status without another review.
// Collaborators with write access can edit it, as they can already post
// statuses through a workflow; the status guards against mistakes, not
// against them. `cleared` tells reviewers' tools, such as the guided-review
// skill, whether the comment says the code needs no second review.
const decisionMarker = (sha, { reasons, reviewer, cleared = false }) =>
  `<!-- claude-review-human ${Buffer.from(JSON.stringify({ sha, reasons, reviewer, cleared })).toString('base64')} -->`;

// The person is asked to decide the reasons, not to repeat the review. When
// the code is cleared (see publish), the comment says so.
function humanSection(sha, decision) {
  const { reasons, reviewer, cleared } = decision;
  const lines = reasons.length
    ? ['**Human review:** needed', ...reasons.map((r) => `- ${clean(r)}`)]
    : ['**Human review:** not needed'];
  if (reasons.length) {
    const ask = 'Decide the points above: approve to accept them, or request changes.';
    lines.push(
      '',
      cleared
        ? `Claude found no P0-P2 problems at ${sha.slice(0, 7)}, so the code needs no second review for bugs. ${ask}`
        : ask,
      '',
      `${reviewer ? `Suggested reviewer: ${code(reviewer.login)} (${clean(reviewer.why)}). ` : ''}Any collaborator with write access other than the author can approve.`,
    );
  }
  return ['', '', ...lines, '', decisionMarker(sha, decision)].join('\n');
}

// Only the marker that ends the comment counts: Claude's text above it could
// contain a lookalike.
function storedDecision(comment, sha) {
  try {
    const encoded = comment.body.match(/\n<!-- claude-review-human ([A-Za-z0-9+/=]+) -->$/)[1];
    const decision = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (decision.sha === sha && Array.isArray(decision.reasons)) {
      const login = decision.reviewer?.login;
      return {
        reasons: decision.reasons.map(String),
        reviewer: typeof login === 'string' ? { login, why: String(decision.reviewer.why) } : null,
      };
    }
  } catch {}
  return null;
}

async function summaryComment(github, context, number) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: number,
    per_page: 100,
  });
  return comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(marker));
}

async function verdictStatus(github, context, sha) {
  const { data } = await github.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: sha, per_page: 100 });
  return data.statuses.find((s) => s.context === statusContext);
}

async function verdictState(github, context, sha) {
  return (await verdictStatus(github, context, sha))?.state ?? 'none';
}

async function permissionOf(github, context, username) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username });
    return data.permission;
  } catch (error) {
    if (error.status !== 404) throw error;
    return 'none';
  }
}

async function livePull(github, context) {
  const { data } = await github.rest.pulls.get({ ...context.repo, pull_number: context.payload.pull_request.number });
  return data;
}

const isFork = (context, pull) => pull.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`;

// Reasons the head needs a person that come from the PR as it is now, not
// from its review.
async function liveReasons(github, context, pull, sha) {
  const reasons = [];
  if (isFork(context, pull)) reasons.push('Claude does not review fork PRs.');
  const status = await verdictStatus(github, context, sha);
  if (status?.state === 'success' && status.description?.startsWith(overridePrefix)) reasons.push(status.description);
  if (pull.labels?.some((l) => l.name === humanLabel)) reasons.push(`The ${humanLabel} label asks for one.`);
  return reasons;
}

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
    if (
      r.user?.type === 'User' &&
      r.user.login !== pull.user?.login &&
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)
    ) {
      latest.set(r.user.login, r);
    }
  }
  const approvers = [];
  const blockers = [];
  for (const [login, r] of latest) {
    if (r.state === 'DISMISSED' || !['admin', 'write'].includes(await permissionOf(github, context, login))) continue;
    if (r.state === 'APPROVED') approvers.push({ login, commit: r.commit_id });
    else blockers.push(login);
  }
  const reviewed = reviews.some((r) => r.user?.type === 'User' && r.user.login !== pull.user?.login);
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
  if (here.length && (status?.state === 'error' || (fallback && status.description !== approved))) {
    await setStatus(github, context, sha, 'success', approved, statusContext, status.target_url);
  } else if (fallback && !here.length) {
    await setStatus(github, context, sha, 'error', incomplete, statusContext, status.target_url);
  }
}

// An approval carries across pushes, as it does under the repositories'
// required approvals today, none of which dismiss stale reviews.
async function setHumanStatus(github, context, pull, sha, reasons) {
  const { approvers, blockers, reviewed } = await standing(github, context, pull);
  const names = approvers.map((a) => a.login);
  const [state, description] = blockers.length
    ? ['pending', `Changes requested by ${blockers.join(', ')}.`]
    : names.length
      ? ['success', `Approved by ${names.join(', ')}.`]
      : reasons.length
        ? ['pending', `Needs human review: ${reasons[0]}`]
        : ['success', 'No human review needed.'];
  await setStatus(github, context, sha, state, fit(description), humanStatusContext);
  await settleIncompleteReview(github, context, sha, approvers);
  return { waiting: state === 'pending' && !blockers.length && !reviewed };
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
    pull.requested_reviewers?.length
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
  if (
    !context.actor.endsWith('[bot]') &&
    !['admin', 'write'].includes(await permissionOf(github, context, context.actor))
  ) {
    return skip(`${context.actor} lacks write access.`);
  }
  await setStatus(github, context, sha, 'pending', 'Claude is reviewing this commit.');
  await setStatus(github, context, sha, 'pending', 'Waiting for the Claude review.', humanStatusContext);
  core.setOutput('review', 'true');
}

// Publishes the review job's verdict: one summary comment per PR, edited in
// place, and the commit statuses for the reviewed head.
async function publish({ github, context, core }) {
  const pr = context.payload.pull_request;
  const pull = await livePull(github, context);
  if (pull.state !== 'open' && (await headReviewedElsewhere(github, context))) {
    core.notice(
      `Skipping the verdict for ${pr.head.sha.slice(0, 7)}: this PR is closed and another open PR has the same head.`,
    );
    return;
  }
  const result = verdict(
    process.env.REVIEW_RESULT,
    process.env.FINDINGS || '',
    pr.head.sha,
    runUrl(context),
    reviewerCandidates(),
  );
  // The status goes first so a failed comment cannot leave the head pending.
  await setStatus(github, context, pr.head.sha, result.state, result.description);
  if (result.state === 'error') core.setFailed(`Claude review did not produce a verdict for ${pr.head.sha}.`);
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
  // The statuses belong to this SHA; the summary belongs to the live head.
  try {
    if (!(await isLiveHead(github, context))) return;
    // A reserved path or the needs-human-review label asks a person whatever
    // Claude decides, so neither is Claude's to clear; unread labels fail closed.
    decision.cleared = Boolean(result.cleared) && !paths.length && live?.length === 0;
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

  // Accepting what Claude says to fix is a judgment call, so the head now
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

// GitHub logins: letters, digits, and single inner hyphens.
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// The candidate logins the review job found, most history first.
function reviewerCandidates() {
  try {
    const logins = JSON.parse(process.env.REVIEWER_CANDIDATES || '[]');
    return Array.isArray(logins) ? logins.filter((l) => typeof l === 'string' && loginPattern.test(l)) : [];
  } catch {
    return [];
  }
}

// Finds who to suggest as the human reviewer: the people with the most recent
// commits to the changed files, which the review job runs before Claude in
// its base checkout. Only the base branch's history counts, since the PR's
// own commits can name any author. Drops the PR author, bots, and anyone
// without write access, who could not approve. Writes reviewers.jsonl for
// Claude and the logins for publish; a failure only leaves both empty.
async function candidates({ github, context, core }) {
  const { base, head, user } = context.payload.pull_request;
  const dir = path.join(process.env.RUNNER_TEMP, 'claude-review');
  let found = [];
  try {
    const git = (...args) =>
      execFileSync('git', ['--literal-pathspecs', ...args], {
        cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
    const changed = git('diff', '--name-only', '-z', '--no-renames', `${base.sha}...${head.sha}`)
      .split('\0')
      .filter(Boolean)
      .slice(0, 300);
    const people = new Map();
    if (changed.length) {
      const wanted = new Set(changed);
      const log = git(
        'log',
        '-n',
        '500',
        '--since=1.year',
        '--no-merges',
        '--format=%x1e%H %ae',
        '--name-only',
        base.sha,
        '--',
        ...changed,
      );
      for (const record of log.split('\x1e').slice(1)) {
        const [header, ...names] = record.split('\n');
        const [sha, email] = header.split(' ');
        const files = names.filter((name) => wanted.has(name));
        if (!email || !files.length) continue;
        // The log runs newest first, so each person keeps their latest commit.
        const person = people.get(email) ?? { sha, commits: 0, files: new Map() };
        person.commits += 1;
        for (const file of files) person.files.set(file, (person.files.get(file) ?? 0) + 1);
        people.set(email, person);
      }
    }
    // Several emails can belong to one login, so merge them by login.
    const byLogin = new Map();
    for (const person of [...people.values()].sort((a, b) => b.commits - a.commits).slice(0, 10)) {
      const { data } = await github.rest.repos.getCommit({ ...context.repo, ref: person.sha });
      const login = data.author?.login;
      if (!login || data.author.type !== 'User' || login === user.login || !loginPattern.test(login)) continue;
      const merged = byLogin.get(login) ?? { login, commits: 0, files: new Map() };
      merged.commits += person.commits;
      for (const [file, count] of person.files) merged.files.set(file, (merged.files.get(file) ?? 0) + count);
      byLogin.set(login, merged);
    }
    for (const person of [...byLogin.values()].sort((a, b) => b.commits - a.commits)) {
      if (found.length === 5) break;
      if (!['admin', 'write'].includes(await permissionOf(github, context, person.login))) continue;
      const files = [...person.files]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([file]) => file);
      found.push({ login: person.login, commits: person.commits, files });
    }
  } catch (error) {
    core.warning(`Could not find reviewer candidates: ${error.message}`);
    found = [];
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewers.jsonl'), found.map((f) => `${JSON.stringify(f)}\n`).join(''));
  core.setOutput('candidates', JSON.stringify(found.map((f) => f.login)));
}

module.exports = {
  statusContext,
  humanStatusContext,
  overrideLabel,
  humanLabel,
  marker,
  severities,
  verdict,
  globRegExp,
  start,
  publish,
  override,
  gate,
  candidates,
};
