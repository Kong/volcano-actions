'use strict';

// Reads each reviewer's structured output, which schema.json describes.

const { severities } = require('./constants.cjs');

// Caps untrusted text at `max` characters, counted as JSON Schema's maxLength
// counts them. A provider whose structured outputs reject maxLength reviews
// with the schema without it, so its text can run longer.
function cap(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

// The verdict job's `needs`, as `toJSON(needs)` renders it. Every job with a
// `reviewer` output is a reviewer, named by it, in the order the object lists
// them. Reviewer candidates come from the first one that reports them; every
// reviewer job finds them from the same base history.
function reviewersOf(raw) {
  let needs;
  try {
    needs = JSON.parse(raw || '{}');
  } catch {
    needs = {};
  }
  const jobs = Object.values(needs && typeof needs === 'object' ? needs : {}).filter(
    (job) => typeof job?.outputs?.reviewer === 'string' && job.outputs.reviewer.trim(),
  );
  return {
    reviewers: jobs.map((job) => ({
      name: job.outputs.reviewer.trim(),
      result: job.result,
      output: job.outputs.findings ?? '',
    })),
    candidates: jobs.find((job) => job.outputs.candidates)?.outputs.candidates ?? '',
  };
}

const ownReasons = (review) =>
  (Array.isArray(review?.human_review?.reasons) ? review.human_review.reasons : [])
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => cap(r.trim(), 200))
    .slice(0, 5);

// Anything but an explicit `needed: false` asks for a person, so a missing or
// malformed decision fails closed without discarding the findings.
function humanReasons({ name, review }) {
  const decision = review?.human_review;
  if (decision?.needed === false) return [];
  const reasons = ownReasons(review);
  if (reasons.length > 0) return reasons;
  return [
    decision?.needed === true
      ? `${name} asked for a human review.`
      : `${name} did not say whether this needs a human review.`,
  ];
}

// Whether the comment may tell a person the code needs no second look: nothing
// blocks, every reviewer says it read the whole change closely and either
// needs no person or asked for one with reasons of its own, and at least one
// asked. Anything else fails closed.
const asksWithReasons = (review) => review.human_review?.needed === true && ownReasons(review).length > 0;
const clearsCode = (reviews, blocking) =>
  blocking.length === 0 &&
  reviews.every((r) => r.reviewed_closely === true && (r.human_review?.needed === false || asksWithReasons(r))) &&
  reviews.some((r) => asksWithReasons(r));

// A reviewer's pick when it is one of the candidates the workflow found, so
// the PR cannot steer the request.
function pickOf({ name, review }, candidates) {
  const decision = review?.human_review;
  const pick = typeof decision?.reviewer === 'string' ? decision.reviewer.trim().replace(/^@/u, '').toLowerCase() : '';
  const login = candidates.find((c) => c.toLowerCase() === pick);
  if (!login) return null;
  const why = typeof decision.reviewer_reason === 'string' ? decision.reviewer_reason.trim().slice(0, 200) : '';
  return { login, why: why || `${name} suggested them` };
}

// The first reviewer's pick among the candidates, in reviewer order;
// otherwise the candidate with the most history in the changed files.
function suggestedReviewer(done, candidates) {
  for (const entry of done) {
    const pick = pickOf(entry, candidates);
    if (pick) return pick;
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

module.exports = {
  cap,
  reviewersOf,
  humanReasons,
  clearsCode,
  suggestedReviewer,
  severityOf,
  parseReview,
  completed,
};
