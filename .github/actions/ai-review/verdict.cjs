'use strict';

const {
  severities,
  failing,
  marker,
  overrideLabel,
  incomplete,
  fit,
  clean,
  code,
  joinNames,
} = require('./constants.cjs');
const { cap, humanReasons, clearsCode, suggestedReviewer, severityOf, parsed, completed } = require('./reviews.cjs');
const { problems } = require('./problems.cjs');

const heading = 'AI review';
const noneCompleted = 'No AI review completed.';
// Says what the review could not verify, so a person checks only that. It
// holds while the review jobs only read the checkout; the workflow tests pin
// each reviewer's tools.
const readOnly =
  "**Not checked:** The AI review read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.";

// Lists from several reviewers combine without repeats; one reviewer's stay
// as it wrote them.
const listsFor = (count) =>
  count > 1 ? (lists) => [...new Set(lists.flat())].slice(0, 5) : (lists) => lists.flat().slice(0, 5);

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
    notChecked: (Array.isArray(review.not_checked) ? review.not_checked : [])
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => cap(n.trim(), 200)),
  };
}

// Every review as one: each problem once, however many reviewers reported it
// (see problems.cjs), and every gap. The summary is the first review's, or,
// when any review blocks, the first blocking review's, so its risk call agrees
// with the heading.
function union(reviews) {
  const shaped = reviews.map((r) => shape(r));
  const blocks = shaped.find((r) => r.findings.some((f) => failing.has(f.severity)));
  return {
    summary: (blocks ?? shaped[0]).summary,
    findings: problems(shaped.map((r) => r.findings)),
    notChecked: shaped.flatMap((r) => r.notChecked),
  };
}

// The summary must not keep showing an earlier head's verdict.
function incompleteVerdict(short, url, candidates, missed) {
  return {
    state: 'error',
    description: incomplete,
    body: [
      marker,
      `### ${heading}: did not complete`,
      '',
      `Reviewing ${short} failed. [Run log](${url})`,
      '',
      `Re-run all jobs in that run, or have a collaborator with write access other than the author approve ${short}, which stands in for the review.`,
    ].join('\n'),
    reasons: [noneCompleted],
    reviewer: suggestedReviewer([], candidates),
    missed,
  };
}

const blockingIn = (findings) => findings.filter((f) => failing.has(f.severity));

// The comment's problems, most severe first, and what the reviews could not
// check.
function findingsBody({ shown, failed, notChecked, short, url, coverage }) {
  const where = (p) => p.at.map(({ path, lines }) => code(lines.length > 0 ? `${path}:${lines.join(',')}` : path));
  const item = (p) => `- ${where(p).join(', ')} ${clean(p.title)}`;
  const body = [
    marker,
    failed
      ? `### ${heading}: ${blockingIn(shown.findings).length} P0-P2 finding(s)`
      : `### ${heading}: no P0-P2 findings`,
    '',
    `Reviewed ${short}.${coverage && ` ${coverage}.`} [Run log](${url})`,
    '',
    clean(shown.summary),
  ];
  for (const [level, label] of Object.entries(severities)) {
    const at = shown.findings.filter((f) => f.severity === level);
    if (at.length > 0) body.push('', `**${label}**`, ...at.map((f) => item(f)));
  }
  body.push('', readOnly, ...notChecked.map((n) => `- ${clean(n)}`));
  return body;
}

// Counts the problems the comment shows, so the status and comment agree.
function describe(failed, findings, coverage) {
  const also = coverage && `; ${coverage}`;
  if (failed) return fit(`${blockingIn(findings).length} P0-P2 finding(s)${also}. See the ${heading} comment.`);
  const count = (level) => findings.filter((f) => f.severity === level).length;
  return fit(`No P0-P2 findings (${count('p3')} P3, ${count('pre_existing')} pre-existing${also}).`);
}

// How many reviews did not complete, without naming them, so the PR shows when
// a verdict rests on fewer reviews than the workflow runs.
const coverageOf = (missed, total) =>
  missed.length > 0 ? `${missed.length} of ${total} reviews did not complete` : '';

// Turns the reviewers' results and structured output, as
// [{ name, result, output }], into one status and comment, the reasons, if
// any, that the head needs a person's review, and who to ask for it. The
// comment reads as one review, whichever and however many completed.
// Reviewer names stay out of everything this returns but `by` and `missed`,
// which only the run log shows.
function verdict(reviewers, sha, url, candidates = []) {
  const short = sha.slice(0, 7);
  const entries = parsed(reviewers);
  const list = listsFor(entries.length);
  const done = entries.filter((entry) => completed(entry.result, entry.review));
  const missed = entries.filter((entry) => !done.includes(entry)).map((entry) => entry.name);
  if (done.length === 0) return incompleteVerdict(short, url, candidates, missed);
  const reviews = done.map((entry) => entry.review);
  const blocking = reviews.flatMap((r) => r.findings).filter((f) => failing.has(severityOf(f)));
  const failed = blocking.length > 0;
  const shown = union(reviews);
  const coverage = coverageOf(missed, entries.length);
  const body = findingsBody({ shown, failed, notChecked: list([shown.notChecked]), short, url, coverage });
  const decision = {
    reasons: list(reviews.map((r) => humanReasons(r))),
    reviewer: suggestedReviewer(reviews, candidates),
    by: joinNames(done.map((entry) => entry.name)),
    missed,
  };
  const description = describe(failed, shown.findings, coverage);
  if (failed) {
    body.push(
      '',
      `Push a fix, or have a collaborator with write access (including the PR author) add the \`${overrideLabel}\` label to accept ${short} as is. An override also needs a human review.`,
    );
    return { state: 'failure', description, body: body.join('\n'), ...decision };
  }
  return { state: 'success', description, body: body.join('\n'), ...decision, cleared: clearsCode(reviews, blocking) };
}

module.exports = { verdict };
