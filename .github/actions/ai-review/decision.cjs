'use strict';

const { clean, code } = require('./constants.cjs');

// The summary comment records the review's reasons for its head and who to
// ask, so later events can re-set the human status without another review.
// Collaborators with write access can edit it, as they can already post
// statuses through a workflow; the status guards against mistakes, not
// against them. `cleared` tells reviewers' tools, such as the guided-review
// skill, whether the comment says the code needs no second review.
const decisionMarker = (sha, { reasons, reviewer, cleared = false }) =>
  `<!-- ai-review-human ${Buffer.from(JSON.stringify({ sha, reasons, reviewer, cleared })).toString('base64')} -->`;

// The person is asked to decide the reasons, not to repeat the review. When
// the code is cleared (see publish), the comment says so, naming the reviews
// that cleared it.
function humanSection(sha, decision) {
  const { reasons, reviewer, cleared, by } = decision;
  const lines =
    reasons.length > 0
      ? ['**Human review:** needed', ...reasons.map((r) => `- ${clean(r)}`)]
      : ['**Human review:** not needed'];
  if (reasons.length > 0) {
    const ask = 'Decide the points above: approve to accept them, or request changes.';
    lines.push(
      '',
      cleared
        ? `${by} found no P0-P2 problems at ${sha.slice(0, 7)}, so the code needs no second review for bugs. ${ask}`
        : ask,
      '',
      `${reviewer ? `Suggested reviewer: ${code(reviewer.login)} (${clean(reviewer.why)}). ` : ''}Any collaborator with write access other than the author can approve.`,
    );
  }
  return ['', '', ...lines, '', decisionMarker(sha, decision)].join('\n');
}

// Only the marker that ends the comment counts: reviewer text above it could
// contain a lookalike.
function storedDecision(comment, sha) {
  try {
    const encoded = comment.body.match(/\n<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u)[1];
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

module.exports = { decisionMarker, humanSection, storedDecision };
