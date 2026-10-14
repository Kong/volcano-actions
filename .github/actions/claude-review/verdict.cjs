'use strict';

const { severities, failing, marker, overrideLabel, incomplete, clean, code } = require('./constants.cjs');

const ownReasons = (review) =>
  (Array.isArray(review?.human_review?.reasons) ? review.human_review.reasons : [])
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => r.trim())
    .slice(0, 5);

// Anything but an explicit `needed: false` asks for a person, so a missing or
// malformed decision fails closed without discarding the findings.
function humanReasons(review) {
  const decision = review?.human_review;
  if (decision?.needed === false) return [];
  const reasons = ownReasons(review);
  if (reasons.length > 0) return reasons;
  return [
    decision?.needed === true
      ? 'Claude asked for a human review.'
      : 'Claude did not say whether this needs a human review.',
  ];
}

// Whether the comment may tell a person the code needs no second look: nothing
// blocks, Claude says it read the whole change closely, and it asked for a
// person with reasons of its own. Anything else fails closed.
const clearsCode = (review, blocking) =>
  blocking.length === 0 &&
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
  const pick = typeof decision?.reviewer === 'string' ? decision.reviewer.trim().replace(/^@/u, '').toLowerCase() : '';
  const login = candidates.find((c) => c.toLowerCase() === pick);
  if (login) {
    const why = typeof decision.reviewer_reason === 'string' ? decision.reviewer_reason.trim().slice(0, 200) : '';
    return { login, why: why || 'Claude suggested them' };
  }
  return candidates.length > 0 ? { login: candidates[0], why: 'most recent history in the changed files' } : null;
}

// Structured output may vary an enum's case, so normalize it, and treat any
// other severity as an incomplete review rather than a passing one.
const severityOf = (f) =>
  String(f?.severity)
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/gu, '_');

function parseReview(output) {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

const completed = (result, review) =>
  result === 'success' &&
  typeof review?.summary === 'string' &&
  Array.isArray(review?.findings) &&
  review.findings.every((f) => Object.hasOwn(severities, severityOf(f)));

// The summary must not keep showing an earlier head's verdict.
function incompleteVerdict(short, url, candidates) {
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

// The comment's findings, most severe first, and what the review could not check.
function findingsBody(review, short, url, blocking) {
  const item = (f) => `- ${code(f.line > 0 ? `${f.path}:${f.line}` : f.path)} ${clean(f.title)}`;
  const body = [
    marker,
    blocking.length > 0
      ? `### Claude review: ${blocking.length} P0-P2 finding(s)`
      : '### Claude review: no P0-P2 findings',
    '',
    `Reviewed ${short}. [Run log](${url})`,
    '',
    clean(review.summary),
  ];
  for (const [level, label] of Object.entries(severities)) {
    const at = review.findings.filter((f) => severityOf(f) === level);
    if (at.length > 0) body.push('', `**${label}**`, ...at.map((f) => item(f)));
  }
  body.push('', ...notChecked(review));
  return body;
}

// Turns the review job's result and structured output into a status and
// comment, the reasons, if any, that the head needs a person's review, and
// who to ask for it.
function verdict(result, output, sha, url, candidates = []) {
  const review = parseReview(output);
  const short = sha.slice(0, 7);
  if (!completed(result, review)) return incompleteVerdict(short, url, candidates);
  const blocking = review.findings.filter((f) => failing.has(severityOf(f)));
  const body = findingsBody(review, short, url, blocking);
  const reasons = humanReasons(review);
  const reviewer = suggestedReviewer(review, candidates);
  if (blocking.length > 0) {
    body.push(
      '',
      `Push a fix, or have a collaborator with write access (including the PR author) add the \`${overrideLabel}\` label to accept ${short} as is. An override also needs a human review.`,
    );
    const description = `${blocking.length} P0-P2 finding(s). See the Claude review comment.`;
    return { state: 'failure', description, body: body.join('\n'), reasons, reviewer };
  }
  const count = (level) => review.findings.filter((f) => severityOf(f) === level).length;
  return {
    state: 'success',
    description: `No P0-P2 findings (${count('p3')} P3, ${count('pre_existing')} pre-existing).`,
    body: body.join('\n'),
    reasons,
    reviewer,
    cleared: clearsCode(review, blocking),
  };
}

module.exports = { verdict };
