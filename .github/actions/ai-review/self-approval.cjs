'use strict';

const { verdictState } = require('./github.cjs');

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
//   one for an earlier head is withdrawn, and the new head gets its own once
//   its review clears it.
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

// The approvals this review gave and has not withdrawn.
const isSelfApproval = (r) =>
  r.user?.login === bot && r.state === 'APPROVED' && String(r.body ?? '').startsWith(selfApprovalMarker);

const approvalBody = (pull, sha) =>
  [
    selfApprovalMarker,
    `The AI review found nothing in ${sha.slice(0, 7)} that needs a person, and ${pull.user.login} may merge such changes on its decision. A new push, a change request, or the needs-human-review label withdraws this approval.`,
  ].join('\n');

const dismissal = (sha) => `The AI review no longer approves ${sha.slice(0, 7)} without a person.`;

// Approves the live head when its author is a self-approver, its verdict
// passes, and `clear` (see human.cjs) holds, and withdraws every other
// approval this review gave. A head the PR has moved past is left to its own
// review. A failed withdrawal fails the job, since the approval could let a
// change merge that needs a person; a failed approval only warns.
async function syncSelfApproval({ github, context, core }, pull, sha, { clear, reviews }) {
  if (pull.head.sha !== sha) return;
  const given = reviews.filter((r) => isSelfApproval(r));
  if (given.length === 0 && !isSelfApprover(pull.user?.login)) return;
  const wanted = clear && isSelfApprover(pull.user?.login) && (await verdictState(github, context, sha)) === 'success';
  const pull_number = pull.number;
  for (const r of given.filter((g) => !wanted || g.commit_id !== sha)) {
    try {
      await github.rest.pulls.dismissReview({
        ...context.repo,
        pull_number,
        review_id: r.id,
        message: dismissal(sha),
        event: 'DISMISS',
      });
    } catch (error) {
      core.setFailed(`Could not withdraw the AI review's approval ${r.id}: ${error.message}`);
    }
  }
  if (!wanted || given.some((g) => g.commit_id === sha)) return;
  try {
    await github.rest.pulls.createReview({
      ...context.repo,
      pull_number,
      commit_id: sha,
      event: 'APPROVE',
      body: approvalBody(pull, sha),
    });
  } catch (error) {
    core.warning(`Could not approve ${sha.slice(0, 7)} for ${pull.user.login}: ${error.message}`);
  }
}

module.exports = { selfApprovalMarker, selfApproverOf, isSelfApprover, namedReviewer, syncSelfApproval };
