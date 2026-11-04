'use strict';

const { statusContext } = require('./constants.cjs');
const { setStatus, verdictStatus, verdictState } = require('./github.cjs');

// A repository that keeps its required approvals can still let some authors
// merge on the AI review's decision: for their PRs, the review approves the
// head itself when nothing calls for a person, and withdraws the approval
// once something does. The caller lists those authors in SELF_APPROVERS, one
// per line, as `login: scope` or `login, reviewed by login: scope`:
//
// - The scope completes "a change that is ..." and narrows what the author
//   may merge without a person (see prepare.cjs). Without one, the review's
//   usual decision applies. An indented line continues the scope above it.
// - The reviewer, when named, is the one asked whenever the author's PR
//   needs a person, in place of the one the review suggests.
// - A line that does not parse names nobody, so a typo can only withhold an
//   approval.
// - The approval comes from the workflow's token, so it counts toward the
//   required approvals only where the repository lets GitHub Actions approve
//   pull requests. It never counts as a person's in the human status, which
//   reads only users' reviews (see human.cjs).
// - Every place that sets the human status re-decides the approval: publish
//   for each reviewed head, override, and gate for reviews and the
//   needs-human-review label. Repositories keep approvals across pushes, so
//   publish withdraws one for an earlier head before the new head's verdict
//   can pass, and the new head gets its own once its review clears it.
// - A person who dismisses the approval keeps it off that commit.
// - The trust goes with the author's PR: a commit someone else pushes to it
//   is reviewed and approved the same way.
// - Withdrawing never depends on SELF_APPROVERS, so a caller stub that omits
//   it can only take an approval away.

const bot = 'github-actions[bot]';
const selfApprovalMarker = '<!-- ai-review-self-approval -->';
const entryPattern =
  /^(?<login>[A-Za-z0-9-]+)(?:\s*,\s*reviewed by\s+(?<reviewer>[A-Za-z0-9-]+))?\s*(?::\s*(?<scope>.*))?$/u;

// Each self-approver by lowercase login, with their scope and reviewer.
function selfApprovers() {
  const entries = new Map();
  let last = null;
  for (const line of (process.env.SELF_APPROVERS || '').split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/u.test(line)) {
      if (last) last.scope = `${last.scope} ${line.trim()}`.trim();
      continue;
    }
    const match = entryPattern.exec(line.trim());
    last = match && { scope: (match.groups.scope ?? '').trim(), reviewer: match.groups.reviewer ?? null };
    if (last) entries.set(match.groups.login.toLowerCase(), last);
  }
  return entries;
}

const selfApproverOf = (login) => (typeof login === 'string' && selfApprovers().get(login.toLowerCase())) || null;
const isSelfApprover = (login) => selfApproverOf(login) !== null;

// The reviewer the caller names for the author's PRs, in the shape of the one
// the review suggests, or null.
function namedReviewer(author) {
  const login = selfApproverOf(author)?.reviewer;
  return login ? { login, why: `reviews what ${author} may not merge alone` } : null;
}

// The approvals this review gave, standing or dismissed.
const isOwn = (r) => r.user?.login === bot && String(r.body ?? '').startsWith(selfApprovalMarker);
const isSelfApproval = (r) => isOwn(r) && r.state === 'APPROVED';

const approvalBody = (pull, sha) =>
  [
    selfApprovalMarker,
    `The AI review found nothing in ${sha.slice(0, 7)} that needs a person, and ${pull.user.login} may merge such changes on its decision. The trust covers every commit on this PR, whoever pushed it. A new push, a change request, or the needs-human-review label withdraws this approval, and dismissing it keeps it off this commit.`,
  ].join('\n');

const dismissal = (sha) => `The AI review no longer approves ${sha.slice(0, 7)} without a person.`;
const unwithdrawn = "Could not withdraw the AI review's approval. Re-run the review.";

// Dismisses each approval, failing the job for any it could not. Says whether
// it dismissed them all.
async function dismiss({ github, context, core }, pull, approvals, sha) {
  let all = true;
  for (const r of approvals) {
    try {
      await github.rest.pulls.dismissReview({
        ...context.repo,
        pull_number: pull.number,
        review_id: r.id,
        message: dismissal(sha),
        event: 'DISMISS',
      });
    } catch (error) {
      all = false;
      core.setFailed(`Could not withdraw the AI review's approval ${r.id}: ${error.message}`);
    }
  }
  return all;
}

// Withdraws the approvals this review gave of any commit but the live head,
// which publish does before the head's verdict passes: the repositories keep
// approvals across pushes, so one of an earlier head would otherwise let the
// new head merge before its own approval is decided. Says whether none is
// left; publish then fails the verdict instead. Unread reviews count as one
// left only where the caller names self-approvers, so an outage elsewhere
// keeps today's verdict.
async function withdrawStale({ github, context, core }, pull) {
  let reviews;
  try {
    reviews = await github.paginate(github.rest.pulls.listReviews, {
      ...context.repo,
      pull_number: pull.number,
      per_page: 100,
    });
  } catch (error) {
    core.warning(`Could not read the reviews to withdraw an earlier approval: ${error.message}`);
    return selfApprovers().size === 0;
  }
  const stale = reviews.filter((r) => isSelfApproval(r) && r.commit_id !== pull.head.sha);
  return dismiss({ github, context, core }, pull, stale, pull.head.sha);
}

// Whether someone other than this review dismissed its approval of `sha`. A
// person who does wants a person's approval, so the review does not approve
// that commit again. An unread timeline counts as a yes.
async function dismissedByPerson({ github, context, core }, pull, sha, reviews) {
  const ids = new Set(
    reviews.filter((r) => isOwn(r) && r.state === 'DISMISSED' && r.commit_id === sha).map((r) => r.id),
  );
  if (ids.size === 0) return false;
  try {
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
      ...context.repo,
      issue_number: pull.number,
      per_page: 100,
    });
    return events.some(
      (e) => e.event === 'review_dismissed' && ids.has(e.dismissed_review?.review_id) && e.actor?.login !== bot,
    );
  } catch (error) {
    core.warning(`Could not read who dismissed the AI review's approval of ${sha.slice(0, 7)}: ${error.message}`);
    return true;
  }
}

// Approves the live head when its author is a self-approver, its verdict
// passes, `clear` (see human.cjs) holds, and no person dismissed this
// review's approval of it, and withdraws every other approval this review
// gave. A head the PR has moved past is left to its own review. A failed
// withdrawal fails the job and the verdict, since the approval could let a
// change merge that needs a person; a failed approval only warns. Says
// whether every withdrawal succeeded, so a caller does not pass the verdict
// after one failed.
async function syncSelfApproval({ github, context, core }, pull, sha, { clear, reviews }) {
  if (pull.head.sha !== sha) return true;
  const given = reviews.filter((r) => isSelfApproval(r));
  const author = pull.user?.login;
  // Only a self-approver's clear head costs the reads that follow.
  const wanted =
    clear &&
    isSelfApprover(author) &&
    (await verdictState(github, context, sha)) === 'success' &&
    !(await dismissedByPerson({ github, context, core }, pull, sha, reviews));
  const stale = given.filter((g) => !wanted || g.commit_id !== sha);
  if (!(await dismiss({ github, context, core }, pull, stale, sha))) {
    const status = await verdictStatus(github, context, sha);
    await setStatus(github, context, sha, 'failure', unwithdrawn, statusContext, status?.target_url);
    return false;
  }
  if (!wanted || given.some((g) => g.commit_id === sha)) return true;
  try {
    await github.rest.pulls.createReview({
      ...context.repo,
      pull_number: pull.number,
      commit_id: sha,
      event: 'APPROVE',
      body: approvalBody(pull, sha),
    });
  } catch (error) {
    core.warning(`Could not approve ${sha.slice(0, 7)} for ${author}: ${error.message}`);
  }
  return true;
}

module.exports = {
  selfApprovalMarker,
  unwithdrawn,
  selfApproverOf,
  isSelfApprover,
  namedReviewer,
  withdrawStale,
  syncSelfApproval,
};
