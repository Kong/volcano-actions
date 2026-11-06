'use strict';

const { clean, code } = require('./constants.cjs');

// The summary comment records the review's reasons for its head and who to
// ask, so later events can re-set the human status without another review.
// Collaborators with write access can edit it, as they can already post
// statuses through a workflow; the status guards against mistakes, not
// against them. `cleared` tells reviewers' tools, such as the guided-review
// skill, whether the comment says the code needs no second review.
// `deferred` names the problems the author deferred, by their keys (see
// problems.cjs), and `since`, when GitHub recorded the summary that first
// reported them, says only an approval of this commit given after then counts
// (see deferral.cjs). `scope`, only for a self-approver's PR, is the scope
// the review weighed (see self-approval.cjs). `owners`, only where the
// repository names them, are the groups an approval must come from (see
// owners.cjs).
const decisionMarker = (
  sha,
  { reasons, reviewer, cleared = false, since = null, deferred = [], scope = null, owners = [] },
) =>
  `<!-- ai-review-human ${Buffer.from(JSON.stringify({ sha, reasons, reviewer, cleared, since, deferred, ...(scope !== null && { scope }), ...(owners.length > 0 && { owners }) })).toString('base64')} -->`;

// Who may approve, as the summary tells the person asked.
function approverNote({ owners = [] }) {
  if (owners.length === 0) return 'Any collaborator with write access other than the author can approve.';
  const groups = owners.map((g) => `one of ${g.logins.map((l) => code(l)).join(', ')} (owns ${code(g.path)})`);
  return `An approval counts only from an owner of the changed paths: ${groups.join('; ')}.`;
}

// The person is asked to decide the reasons, not to repeat the review. When
// the code is cleared (see publish), the comment says so.
function humanSection(sha, decision) {
  const { reasons, reviewer, cleared, deferred = [] } = decision;
  const lines =
    reasons.length > 0
      ? ['**Human review:** needed', ...reasons.map((r) => `- ${clean(r)}`)]
      : ['**Human review:** not needed'];
  if (reasons.length > 0) {
    const ask =
      deferred.length > 0
        ? `Decide the points above: approve ${sha.slice(0, 7)} now to accept them, since an approval given before the deferral did not decide it, or request changes.`
        : 'Decide the points above: approve to accept them, or request changes.';
    lines.push(
      '',
      cleared
        ? `The AI review found no P0-P2 problems at ${sha.slice(0, 7)}, so the code needs no second review for bugs. ${ask}`
        : ask,
      '',
      `${reviewer ? `Suggested reviewer: ${code(reviewer.login)} (${clean(reviewer.why)}). ` : ''}${approverNote(decision)}`,
    );
  }
  return ['', '', ...lines, '', decisionMarker(sha, decision)].join('\n');
}

// The marker as it ends the comment. Only that one counts: reviewer text above
// it could contain a lookalike.
const storedMarker = /\n<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u;

// Stored owner groups, keeping only well-formed ones.
const ownersOf = (groups) =>
  (Array.isArray(groups) ? groups : [])
    .filter((g) => typeof g?.path === 'string' && Array.isArray(g.logins))
    .map((g) => ({ path: g.path, logins: g.logins.filter((l) => typeof l === 'string') }))
    .filter((g) => g.logins.length > 0);

function storedDecision(comment, sha) {
  try {
    const encoded = comment.body.match(storedMarker)[1];
    const decision = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (decision.sha === sha && Array.isArray(decision.reasons)) {
      const login = decision.reviewer?.login;
      return {
        reasons: decision.reasons.map(String),
        reviewer: typeof login === 'string' ? { login, why: String(decision.reviewer.why) } : null,
        since: typeof decision.since === 'string' ? decision.since : null,
        deferred: Array.isArray(decision.deferred) ? decision.deferred.map(String) : [],
        scope: typeof decision.scope === 'string' ? decision.scope : null,
        owners: ownersOf(decision.owners),
      };
    }
  } catch {}
  return null;
}

module.exports = { decisionMarker, storedMarker, humanSection, storedDecision };
