'use strict';

const { clean, code } = require('./constants.cjs');

// The summary comment records the review's reasons for its head and who to
// ask, so later events can re-set the human status without another review.
// Collaborators with write access can edit it, as they can already post
// statuses through a workflow; the status guards against mistakes, not
// against them. `cleared` tells reviewers' tools, such as the guided-review
// skill, whether the comment says the code needs no second review. `exact`
// says only an approval of this commit counts, as when the author deferred a
// finding after an earlier approval.
const decisionMarker = (sha, { reasons, reviewer, cleared = false, exact = false }) =>
  `<!-- ai-review-human ${Buffer.from(JSON.stringify({ sha, reasons, reviewer, cleared, exact })).toString('base64')} -->`;

// The person is asked to decide the reasons, not to repeat the review. When
// the code is cleared (see publish), the comment says so.
function humanSection(sha, decision) {
  const { reasons, reviewer, cleared, exact } = decision;
  const lines =
    reasons.length > 0
      ? ['**Human review:** needed', ...reasons.map((r) => `- ${clean(r)}`)]
      : ['**Human review:** not needed'];
  if (reasons.length > 0) {
    const ask = exact
      ? `Decide the points above: approve ${sha.slice(0, 7)} itself to accept them, since an approval of an earlier commit predates the deferral, or request changes.`
      : 'Decide the points above: approve to accept them, or request changes.';
    lines.push(
      '',
      cleared
        ? `The AI review found no P0-P2 problems at ${sha.slice(0, 7)}, so the code needs no second review for bugs. ${ask}`
        : ask,
      '',
      `${reviewer ? `Suggested reviewer: ${code(reviewer.login)} (${clean(reviewer.why)}). ` : ''}Any collaborator with write access other than the author can approve.`,
    );
  }
  return ['', '', ...lines, '', decisionMarker(sha, decision)].join('\n');
}

// The marker as it ends the comment. Only that one counts: reviewer text above
// it could contain a lookalike.
const storedMarker = /\n<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u;

function storedDecision(comment, sha) {
  try {
    const encoded = comment.body.match(storedMarker)[1];
    const decision = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (decision.sha === sha && Array.isArray(decision.reasons)) {
      const login = decision.reviewer?.login;
      return {
        reasons: decision.reasons.map(String),
        reviewer: typeof login === 'string' ? { login, why: String(decision.reviewer.why) } : null,
        exact: decision.exact === true,
      };
    }
  } catch {}
  return null;
}

module.exports = { decisionMarker, storedMarker, humanSection, storedDecision };
