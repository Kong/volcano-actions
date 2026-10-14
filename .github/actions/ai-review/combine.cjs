'use strict';

// Combines completed reviews into the one review the summary comment shows.
// Only the comment's text comes from here: publish decides the verdict, the
// human review, and the suggested reviewer from the reviews themselves.

const { severities, failing } = require('./constants.cjs');
const { cap, severityOf } = require('./reviews.cjs');

const texts = (value, max) =>
  (Array.isArray(value) ? value : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => cap(t.trim(), max));
const distinct = (items) => [...new Set(items)].slice(0, 5);

// A review's text at the schema's lengths, with its severities normalized.
function shape(review) {
  return {
    summary: cap(review.summary, 1500),
    findings: review.findings.map((f) => ({
      severity: severityOf(f),
      path: cap(String(f.path), 300),
      line: f.line,
      title: cap(String(f.title), 200),
    })),
    notChecked: texts(review.not_checked, 200),
  };
}

// A review as schema.json describes it, at its lengths, for a merge to read.
// A decision that is not an explicit `needed: false` asks for a person.
function asWritten(review) {
  const decision = review.human_review ?? {};
  const { summary, findings, notChecked } = shape(review);
  const short = (value, max) => (typeof value === 'string' ? cap(value.trim(), max) : '');
  return {
    summary,
    findings,
    human_review: {
      needed: decision.needed !== false,
      reasons: texts(decision.reasons, 200).slice(0, 5),
      reviewer: short(decision.reviewer, 100),
      reviewer_reason: short(decision.reviewer_reason, 200),
    },
    not_checked: notChecked.slice(0, 5),
    reviewed_closely: review.reviewed_closely === true,
  };
}

const sameProblem = (f) =>
  JSON.stringify([
    f.severity,
    f.path,
    f.line,
    f.title
      .toLowerCase()
      .replaceAll(/\s+/gu, ' ')
      .replace(/[\s.!]+$/u, '')
      .trim(),
  ]);

// Every review's findings without exact repeats, the first review's summary,
// and their gaps without repeats: the comment when no merge is available.
function union(reviews) {
  const shaped = reviews.map((r) => shape(r));
  const findings = new Map();
  for (const f of shaped.flatMap((r) => r.findings)) {
    if (!findings.has(sameProblem(f))) findings.set(sameProblem(f), f);
  }
  return {
    summary: shaped[0].summary,
    findings: [...findings.values()],
    notChecked: distinct(shaped.flatMap((r) => r.notChecked)),
  };
}

const rank = (severity) => Object.keys(severities).indexOf(severity);
// The most severe level among the findings, as a rank; Infinity for none.
const highest = (findings) => Math.min(...findings.map((f) => rank(f.severity)));
const blocks = (findings) => findings.some((f) => failing.has(f.severity));

// Why the merged findings misreport the reviews' own, or '' when they do not.
// The verdict comes from the reviews, so the comment must agree with it.
function misreport(merged, reviewed) {
  if (merged.some((f) => !Object.hasOwn(severities, f.severity))) return 'gave a finding an unknown severity';
  if (merged.length > reviewed.length) return 'added findings';
  if (blocks(reviewed) && !blocks(merged)) return 'dropped every P0-P2 finding';
  if (highest(merged) > highest(reviewed)) return 'lowered the highest severity';
  if (blocks(merged) && !blocks(reviewed)) return 'raised a finding to P0-P2';
  return '';
}

// The merged review for the comment, keeping the reviews' own findings when
// the merged ones misreport them. `why` says what the merge got wrong.
function present(output, reviews) {
  const reviewed = union(reviews).findings;
  const merged = shape(output);
  const why = misreport(merged.findings, reviewed);
  return {
    review: {
      summary: merged.summary,
      findings: why ? reviewed : merged.findings,
      notChecked: distinct(merged.notChecked),
      reasons: distinct(texts(output.human_review.reasons, 200)),
    },
    why,
  };
}

const isText = (value) => typeof value === 'string';
const isTexts = (value) => Array.isArray(value) && value.every((v) => isText(v));
const isFinding = (f) =>
  isText(f?.severity) && isText(f.path) && Number.isInteger(f.line) && f.line >= 0 && isText(f.title);
const isDecision = (h) =>
  typeof h?.needed === 'boolean' && isTexts(h.reasons) && isText(h.reviewer) && isText(h.reviewer_reason);

// Whether a merge returned a review in schema.json's shape. Lengths are capped
// rather than checked, and severities are checked against the reviews'.
const fitsSchema = (r) =>
  isText(r?.summary) &&
  Array.isArray(r.findings) &&
  r.findings.every((f) => isFinding(f)) &&
  isDecision(r.human_review) &&
  isTexts(r.not_checked) &&
  typeof r.reviewed_closely === 'boolean';

module.exports = { shape, asWritten, union, present, fitsSchema };
