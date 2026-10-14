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
const {
  cap,
  humanReasons,
  clearsCode,
  suggestedReviewer,
  severityOf,
  parseReview,
  completed,
} = require('./reviews.cjs');

const heading = 'AI review';
const noneCompleted = 'No AI review completed.';

// How the comment presents the reviews. With one reviewer it reads as that
// reviewer's alone; with several, each item says whose it is and lists are
// merged without repeats.
const single = {
  tag: () => '',
  summary: (entry) => clean(cap(entry.review.summary, 1500)),
  merge: (lists) => lists.flat().slice(0, 5),
};
const several = {
  tag: (name) => ` (${name})`,
  summary: (entry) => `**${entry.name}:** ${clean(cap(entry.review.summary, 1500))}`,
  merge: (lists) => [...new Set(lists.flat())].slice(0, 5),
};

// Says what the reviews could not verify, so a person checks only that. The
// first line holds while the review jobs only read the checkout and leave
// inline comments; the workflow tests pin each reviewer's tools.
function notChecked(done, style) {
  const names = done.map((entry) => entry.name);
  const items = done.map((entry) =>
    (Array.isArray(entry.review.not_checked) ? entry.review.not_checked : [])
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => `- ${clean(cap(n.trim(), 200))}`),
  );
  return [
    names.length > 1
      ? `**Not checked:** ${joinNames(names)} read the diff, the code, and the PR's text; they ran no tests or builds and read nothing outside this repository.`
      : `**Not checked:** ${names[0]} read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.`,
    ...style.merge(items),
  ];
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

// The comment's findings, most severe first, and what the reviews could not check.
function findingsBody({ done, missed, findings, blocking, short, url, style }) {
  const item = ({ f, by }) => {
    const file = cap(String(f.path), 300);
    return `- ${code(f.line > 0 ? `${file}:${f.line}` : file)} ${clean(cap(String(f.title), 200))}${style.tag(by)}`;
  };
  const body = [
    marker,
    blocking.length > 0 ? `### ${heading}: ${blocking.length} P0-P2 finding(s)` : `### ${heading}: no P0-P2 findings`,
    '',
    `Reviewed ${short}. [Run log](${url})`,
    ...missed.flatMap((name) => ['', `${name} review did not complete. [Run log](${url})`]),
    '',
    done.map((entry) => style.summary(entry)).join('\n\n'),
  ];
  for (const [level, label] of Object.entries(severities)) {
    const at = findings.filter(({ f }) => severityOf(f) === level);
    if (at.length > 0) body.push('', `**${label}**`, ...at.map((x) => item(x)));
  }
  body.push('', ...notChecked(done, style));
  return body;
}

// Reviews that did not complete leave the verdict to those that did, and the
// status says so.
function describe({ done, missed, findings, blocking }) {
  const names = done.map((entry) => entry.name);
  const only = missed.length > 0 ? `${joinNames(names)} only; ${joinNames(missed)} did not complete` : '';
  if (blocking.length > 0) {
    return fit(`${blocking.length} P0-P2 finding(s)${only && ` (${only})`}. See the ${heading} comment.`);
  }
  const count = (level) => findings.filter(({ f }) => severityOf(f) === level).length;
  return fit(`No P0-P2 findings (${count('p3')} P3, ${count('pre_existing')} pre-existing${only && `; ${only}`}).`);
}

// Turns the reviewers' results and structured output, as
// [{ name, result, output }], into one status and comment, the reasons, if
// any, that the head needs a person's review, and who to ask for it.
function verdict(reviewers, sha, url, candidates = []) {
  const short = sha.slice(0, 7);
  const entries = reviewers.map(({ name, result, output }) => ({ name, result, review: parseReview(output) }));
  const style = entries.length > 1 ? several : single;
  const done = entries.filter((entry) => completed(entry.result, entry.review));
  const missed = entries.filter((entry) => !done.includes(entry)).map((entry) => entry.name);
  if (done.length === 0) return incompleteVerdict(short, url, candidates, missed);
  const findings = done.flatMap((entry) => entry.review.findings.map((f) => ({ f, by: entry.name })));
  const blocking = findings.filter(({ f }) => failing.has(severityOf(f)));
  const parts = { done, missed, findings, blocking, short, url, style };
  const body = findingsBody(parts);
  const decision = {
    reasons: style.merge(done.map((entry) => humanReasons(entry))),
    reviewer: suggestedReviewer(done, candidates),
    by: joinNames(done.map((entry) => entry.name)),
    missed,
  };
  if (blocking.length > 0) {
    body.push(
      '',
      `Push a fix, or have a collaborator with write access (including the PR author) add the \`${overrideLabel}\` label to accept ${short} as is. An override also needs a human review.`,
    );
    return { state: 'failure', description: describe(parts), body: body.join('\n'), ...decision };
  }
  return {
    state: 'success',
    description: describe(parts),
    body: body.join('\n'),
    ...decision,
    cleared: clearsCode(
      done.map((entry) => entry.review),
      blocking,
    ),
  };
}

module.exports = { verdict };
