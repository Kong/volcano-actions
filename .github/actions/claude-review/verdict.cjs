'use strict';

const { severities, failing, marker, overrideLabel, incomplete, fit, clean, code } = require('./constants.cjs');
const {
  cap,
  humanReasons,
  clearsCode,
  suggestedReviewer,
  severityOf,
  parseReview,
  completed,
} = require('./reviews.cjs');

// How the comment presents the reviews. With Claude alone it reads as it did
// before Codex reviewed too; with both, each item says whose it is and lists
// are merged without repeats.
const claudeOnly = {
  heading: 'Claude review',
  incompleteReason: 'The Claude review did not complete.',
  tag: () => '',
  summary: (entry) => clean(cap(entry.review.summary, 1500)),
  merge: (lists) => lists.flat().slice(0, 5),
};
const withCodex = {
  heading: 'AI review',
  incompleteReason: 'Neither the Claude nor the Codex review completed.',
  tag: (name) => ` (${name})`,
  summary: (entry) => `**${entry.name}:** ${clean(cap(entry.review.summary, 1500))}`,
  merge: (lists) => [...new Set(lists.flat())].slice(0, 5),
};

// Says what the reviews could not verify, so a person checks only that. The
// first line holds while the review jobs only read the checkout and leave
// inline comments; the workflow test pins Claude's tool list.
function notChecked(done, style) {
  const names = done.map((entry) => entry.name);
  const items = done.map((entry) =>
    (Array.isArray(entry.review.not_checked) ? entry.review.not_checked : [])
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => `- ${clean(cap(n.trim(), 200))}`),
  );
  return [
    names.length > 1
      ? `**Not checked:** ${names.join(' and ')} read the diff, the code, and the PR's text; they ran no tests or builds and read nothing outside this repository.`
      : `**Not checked:** ${names[0]} read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.`,
    ...style.merge(items),
  ];
}

// The summary must not keep showing an earlier head's verdict.
function incompleteVerdict(short, url, candidates, style, missed) {
  return {
    state: 'error',
    description: incomplete,
    body: [
      marker,
      `### ${style.heading}: did not complete`,
      '',
      `Reviewing ${short} failed. [Run log](${url})`,
      '',
      `Re-run all jobs in that run, or have a collaborator with write access other than the author approve ${short}, which stands in for the review.`,
    ].join('\n'),
    reasons: [style.incompleteReason],
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
    blocking.length > 0
      ? `### ${style.heading}: ${blocking.length} P0-P2 finding(s)`
      : `### ${style.heading}: no P0-P2 findings`,
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

// A review that did not complete leaves the verdict to the other, and the
// status says so.
function describe({ done, missed, findings, blocking, style }) {
  const only = missed.length > 0 ? `${done[0].name} only; ${missed[0]} did not complete` : '';
  if (blocking.length > 0) {
    return fit(`${blocking.length} P0-P2 finding(s)${only && ` (${only})`}. See the ${style.heading} comment.`);
  }
  const count = (level) => findings.filter(({ f }) => severityOf(f) === level).length;
  return fit(`No P0-P2 findings (${count('p3')} P3, ${count('pre_existing')} pre-existing${only && `; ${only}`}).`);
}

// Turns the review jobs' results and structured output into one status and
// comment, the reasons, if any, that the head needs a person's review, and who
// to ask for it. Without a Codex result, as from callers that run no Codex
// review, Claude's review is the verdict.
function verdict(result, output, sha, url, candidates = [], codex = {}) {
  const short = sha.slice(0, 7);
  const entries = [{ name: 'Claude', result, review: parseReview(output) }];
  if (codex?.result) entries.push({ name: 'Codex', result: codex.result, review: parseReview(codex.output) });
  const style = entries.length > 1 ? withCodex : claudeOnly;
  const done = entries.filter((entry) => completed(entry.result, entry.review));
  const missed = entries.filter((entry) => !done.includes(entry)).map((entry) => entry.name);
  if (done.length === 0) return incompleteVerdict(short, url, candidates, style, missed);
  const findings = done.flatMap((entry) => entry.review.findings.map((f) => ({ f, by: entry.name })));
  const blocking = findings.filter(({ f }) => failing.has(severityOf(f)));
  const parts = { done, missed, findings, blocking, short, url, style };
  const body = findingsBody(parts);
  const decision = {
    reasons: style.merge(done.map((entry) => humanReasons(entry))),
    reviewer: suggestedReviewer(done, candidates),
    by: done.map((entry) => entry.name).join(' and '),
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
