'use strict';

// Names and text helpers the review's steps share.

const statusContext = 'ai-review/verdict';
// Whether the head still needs a person's review: it passes when nothing calls
// for one, or once a collaborator with write access other than the author
// approves. Repositories that require it can drop their required approvals.
const humanStatusContext = 'ai-review/human';
const overrideLabel = 'ai-review-override';
const humanLabel = 'needs-human-review';
const marker = '<!-- ai-review-verdict -->';
// Severity levels, most severe first: Codex review's P0-P3 priorities, plus
// pre-existing problems the PR did not cause.
const severities = { p0: '🔴 P0', p1: '🟠 P1', p2: '🟡 P2', p3: '⚪ P3', pre_existing: '🟣 Pre-existing' };
const failing = new Set(['p0', 'p1', 'p2']);

const runUrl = (context) =>
  `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
const overridePrefix = 'Failing verdict overridden by ';
const overriddenBy = (login) => `${overridePrefix}${login}.`;
const incomplete = 'Review did not complete. Re-run it, or have a writer approve this commit.';
const approvedPrefix = 'Review did not complete; approved by ';
// Commit status descriptions are capped at 140 characters.
const fit = (text) => (text.length <= 140 ? text : `${text.slice(0, 139)}…`);

// Breaks @mentions and inline code spans so finding text cannot ping people or
// escape its formatting.
const clean = (text) => String(text).replaceAll('@', '@\u200B');
const code = (text) => `\`${String(text).replaceAll('`', "'")}\``;

// Reviewer names as prose: "Claude", "Claude and Codex", "A, B, and C".
function joinNames(names) {
  if (names.length < 3) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

module.exports = {
  statusContext,
  humanStatusContext,
  overrideLabel,
  humanLabel,
  marker,
  severities,
  failing,
  runUrl,
  overridePrefix,
  overriddenBy,
  incomplete,
  approvedPrefix,
  fit,
  clean,
  code,
  joinNames,
};
