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
const { humanReasons, clearsCode, suggestedReviewer, severityOf, parsed, completed } = require('./reviews.cjs');
const { shape, union } = require('./combine.cjs');

const heading = 'AI review';
const noneCompleted = 'No AI review completed.';
// Says what the review could not verify, so a person checks only that. It
// holds while the review jobs only read the checkout and leave inline
// comments; the workflow tests pin each reviewer's tools.
const readOnly =
  "**Not checked:** The AI review read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.";

// Lists from several reviewers merge without repeats; one reviewer's stay as
// it wrote them.
const listsFor = (count) =>
  count > 1 ? (lists) => [...new Set(lists.flat())].slice(0, 5) : (lists) => lists.flat().slice(0, 5);

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

// The comment's findings, most severe first, and what the review could not
// check, all from the one review it shows.
function findingsBody({ shown, failed, notChecked, short, url }) {
  const item = (f) => `- ${code(f.line > 0 ? `${f.path}:${f.line}` : f.path)} ${clean(f.title)}`;
  const body = [
    marker,
    failed
      ? `### ${heading}: ${blockingIn(shown.findings).length} P0-P2 finding(s)`
      : `### ${heading}: no P0-P2 findings`,
    '',
    `Reviewed ${short}. [Run log](${url})`,
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

// Counts the findings the comment shows, so the status and comment agree.
function describe(failed, findings) {
  if (failed) return fit(`${blockingIn(findings).length} P0-P2 finding(s). See the ${heading} comment.`);
  const count = (level) => findings.filter((f) => f.severity === level).length;
  return fit(`No P0-P2 findings (${count('p3')} P3, ${count('pre_existing')} pre-existing).`);
}

// Turns the reviewers' results and structured output, as
// [{ name, result, output }], into one status and comment, the reasons, if
// any, that the head needs a person's review, and who to ask for it. The
// comment shows one review: the only one that completed, `merged` (see
// merge.cjs), or else every review's findings without repeats. The state, the
// need for a person, and whether the code is cleared come from the reviews
// themselves, so a merge can change how the review reads but never what it
// decides. Reviewer names stay out of everything this returns but `by` and
// `missed`, which only the run log shows.
function verdict(reviewers, sha, url, candidates = [], merged = null) {
  const short = sha.slice(0, 7);
  const entries = parsed(reviewers);
  const list = listsFor(entries.length);
  const done = entries.filter((entry) => completed(entry.result, entry.review));
  const missed = entries.filter((entry) => !done.includes(entry)).map((entry) => entry.name);
  if (done.length === 0) return incompleteVerdict(short, url, candidates, missed);
  const reviews = done.map((entry) => entry.review);
  const blocking = reviews.flatMap((r) => r.findings).filter((f) => failing.has(severityOf(f)));
  const failed = blocking.length > 0;
  const shown = reviews.length === 1 ? shape(reviews[0]) : (merged ?? union(reviews));
  const body = findingsBody({ shown, failed, notChecked: list([shown.notChecked]), short, url });
  const asked = list(reviews.map((r) => humanReasons(r)));
  const decision = {
    reasons: asked.length > 0 && shown.reasons?.length > 0 ? shown.reasons : asked,
    reviewer: suggestedReviewer(reviews, candidates),
    by: joinNames(done.map((entry) => entry.name)),
    missed,
  };
  const description = describe(failed, shown.findings);
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
