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
      deferred: f.deferred === true,
    })),
    notChecked: (Array.isArray(review.not_checked) ? review.not_checked : [])
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => cap(n.trim(), 200)),
  };
}

// A P2 the PR author deferred, which a person decides instead of the verdict.
const deferrable = (f) => f.severity === 'p2' && f.deferred;
// A problem by its title and every location, which tells apart two problems
// one reviewer gave the same title.
const identity = (p) => [p.title, ...p.at.map(({ path, lines }) => `${path}:${lines.join(',')}`)].join(' @ ');

// Every review as one: each problem once, however many reviewers reported it
// (see problems.cjs), and every gap. The summary is the first review's, or,
// when any review blocks, the first blocking review's, so its risk call agrees
// with the heading.
function union(reviews) {
  const shaped = reviews.map((r) => shape(r));
  const blocks = shaped.find((r) => r.findings.some((f) => failing.has(f.severity) && !deferrable(f)));
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

const blockingIn = (problems) => problems.filter((p) => failing.has(p.severity) && !p.deferred);
const deferredIn = (problems) => problems.filter((p) => p.deferred);
const deferredLabel = '⏸️ Deferred P2, for a person to decide';

function headline(problems, failed) {
  if (failed) return `${blockingIn(problems).length} P0-P2 finding(s)`;
  const deferred = deferredIn(problems).length;
  return deferred > 0 ? `${deferred} deferred P2 finding(s)` : 'no P0-P2 findings';
}

// The comment's problems, most severe first, and what the reviews could not
// check.
function findingsBody({ shown, failed, notChecked, short, url, coverage }) {
  const where = (p) => p.at.map(({ path, lines }) => code(lines.length > 0 ? `${path}:${lines.join(',')}` : path));
  const also = (p) => (p.also.length > 0 ? ` (also reported as: ${p.also.map((t) => clean(t)).join('; ')})` : '');
  const item = (p) => `- ${where(p).join(', ')} ${clean(p.title)}${also(p)}`;
  const body = [
    marker,
    `### ${heading}: ${headline(shown.findings, failed)}`,
    '',
    `Reviewed ${short}.${coverage && ` ${coverage}.`} [Run log](${url})`,
    '',
    clean(shown.summary),
  ];
  const sections = Object.entries(severities).flatMap(([level, label]) => [
    [label, shown.findings.filter((p) => p.severity === level && !p.deferred)],
    ...(level === 'p2' ? [[deferredLabel, deferredIn(shown.findings)]] : []),
  ]);
  for (const [label, at] of sections) {
    if (at.length > 0) body.push('', `**${label}**`, ...at.map((p) => item(p)));
  }
  body.push('', readOnly, ...notChecked.map((n) => `- ${clean(n)}`));
  return body;
}

// Counts the problems the comment shows, so the status and comment agree.
function describe(failed, problems, coverage) {
  const also = coverage && `; ${coverage}`;
  if (failed) return fit(`${headline(problems, failed)}${also}. See the ${heading} comment.`);
  const count = (level) => problems.filter((p) => p.severity === level).length;
  const deferred = deferredIn(problems).length;
  const lead = deferred > 0 ? `${deferred} deferred P2 finding(s) for a person` : 'No P0-P2 findings';
  return fit(`${lead} (${count('p3')} P3, ${count('pre_existing')} pre-existing${also}).`);
}

// A person decides whether deferred findings can wait.
const deferralReasons = (problems) =>
  deferredIn(problems).length > 0
    ? ['Can the P2 finding(s) the author deferred or declined, listed in the summary, stand as the author answered?']
    : [];

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
  const shown = union(reviews);
  const blocking = blockingIn(shown.findings);
  const failed = blocking.length > 0;
  const coverage = coverageOf(missed, entries.length);
  const body = findingsBody({ shown, failed, notChecked: list([shown.notChecked]), short, url, coverage });
  const decision = {
    reasons: [...deferralReasons(shown.findings), ...list(reviews.map((r) => humanReasons(r)))],
    reviewer: suggestedReviewer(reviews, candidates),
    by: joinNames(done.map((entry) => entry.name)),
    missed,
    // A person decides each deferral, after it was made (see publish).
    deferred: deferredIn(shown.findings).map((p) => identity(p)),
  };
  const description = describe(failed, shown.findings, coverage);
  if (failed) {
    body.push(
      '',
      `Push a fix, or have a collaborator with write access (including the PR author) add the \`${overrideLabel}\` label to accept ${short} as is. An override also needs a human review.`,
    );
    return { state: 'failure', description, body: body.join('\n'), ...decision };
  }
  // Deferred findings are known problems, so the code is not cleared.
  const cleared = clearsCode(reviews, blocking) && deferredIn(shown.findings).length === 0;
  return { state: 'success', description, body: body.join('\n'), ...decision, cleared };
}

module.exports = { verdict };
