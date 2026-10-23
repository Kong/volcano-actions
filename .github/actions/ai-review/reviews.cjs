'use strict';

// Reads each reviewer's structured output, which schema.json describes.

const fs = require('node:fs');
const path = require('node:path');
const { severities } = require('./constants.cjs');

// Caps untrusted text at `max` characters, counted as JSON Schema's maxLength
// counts them. A provider whose structured outputs reject maxLength reviews
// with the schema without it, so its text can run longer.
function cap(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

// A reviewer job's structured output, `ai-review-<job ID>.json` in `dir`,
// where the verdict job downloads the job's artifact of that name. It travels
// as a file because an environment variable holds at most 128 KiB, and a
// provider without maxLength can write more. A missing or unreadable file
// reads as no output, so that review did not complete; `unread` says why.
function outputOf(dir, id) {
  const name = `ai-review-${id}.json`;
  if (!dir) return { output: '', unread: `no directory holds ${name}` };
  try {
    return { output: fs.readFileSync(path.join(dir, name), 'utf8') };
  } catch (error) {
    return { output: '', unread: error.message };
  }
}

// The verdict job's `needs`, as `toJSON(needs)` renders it, with each job's
// structured output from `dir`. The verdict job needs only reviewer jobs, so
// every entry is a reviewer, in the order the object lists them. Each is named
// by its `reviewer` output, or by its job ID when it set no outputs, as when
// it was skipped, so a reviewer that did not run is still reported as
// incomplete. Its `model` output names the model that reviewed, if any.
// Reviewer candidates come from the first one that reports them; every
// reviewer job finds them from the same base history.
function reviewersOf(raw, dir) {
  let needs;
  try {
    needs = JSON.parse(raw || '{}');
  } catch {
    needs = {};
  }
  const entries = needs && typeof needs === 'object' && !Array.isArray(needs) ? Object.entries(needs) : [];
  const jobs = entries.filter(([, job]) => job && typeof job === 'object');
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    reviewers: jobs.map(([id, job]) => ({
      name: text(job.outputs?.reviewer) || `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
      model: text(job.outputs?.model),
      result: job.result,
      ...outputOf(dir, id),
    })),
    candidates: jobs.find(([, job]) => job.outputs?.candidates)?.[1].outputs.candidates ?? '',
  };
}

const ownReasons = (review) =>
  (Array.isArray(review?.human_review?.reasons) ? review.human_review.reasons : [])
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => cap(r.trim(), 200))
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
      ? 'The AI review asked for a human review.'
      : 'The AI review did not say whether this needs a human review.',
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
function pickOf(review, candidates) {
  const decision = review?.human_review;
  const pick = typeof decision?.reviewer === 'string' ? decision.reviewer.trim().replace(/^@/u, '').toLowerCase() : '';
  const login = candidates.find((c) => c.toLowerCase() === pick);
  if (!login) return null;
  const why = typeof decision.reviewer_reason === 'string' ? decision.reviewer_reason.trim().slice(0, 200) : '';
  return { login, why: why || 'the AI review suggested them' };
}

// The first review's pick among the candidates, in reviewer order; otherwise
// the candidate with the most history in the changed files.
function suggestedReviewer(reviews, candidates) {
  for (const review of reviews) {
    const pick = pickOf(review, candidates);
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

// A finding as the summary and the inline comments group it: its severity
// normalized and its text at the schema's lengths.
const shapeFinding = (f) => ({
  severity: severityOf(f),
  path: cap(String(f.path), 300),
  line: f.line,
  title: cap(String(f.title), 200),
  deferred: f.deferred === true,
});

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

// Each reviewer as [{ name, model, result, review }], with its structured
// output parsed.
const parsed = (reviewers) =>
  reviewers.map(({ name, model, result, output }) => ({ name, model, result, review: parseReview(output) }));

module.exports = {
  cap,
  reviewersOf,
  humanReasons,
  clearsCode,
  suggestedReviewer,
  severityOf,
  shapeFinding,
  parsed,
  completed,
};
