'use strict';

const { selfApproverOf } = require('./self-approval.cjs');
const { parsed, completed } = require('./reviews.cjs');

// A self-approver's scope behind a feature flag (see self-approval.cjs) holds
// only on evidence publish can check, so the review's word alone never lets
// such a change merge. Each review that clears the change under that scope
// must cite the flag checks that keep it off, and each cited line must, in the
// head revision, match the repository's FEATURE_FLAG_CHECK, name the flag in
// quotes, and be a line the PR did not add or change: a flag check the PR adds
// needs a person. Whether every changed line sits behind a cited check, and
// how the flag is rolled out, stay the review's call.

// The head-revision lines a file's patch adds or changes.
function addedLines(patch) {
  const added = new Set();
  let line = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(row);
    if (hunk) line = Number(hunk[1]);
    else if (row.startsWith('+')) added.add(line++);
    else if (!row.startsWith('-') && !row.startsWith('\\')) line++;
  }
  return added;
}

const flagName = /^[\w.:/-]{1,100}$/u;
const quotes = (text, flag) => ['"', "'", '`'].some((q) => text.includes(`${q}${flag}${q}`));

// The repository's flag check as a RegExp, or null when it names none.
function flagCheck() {
  try {
    return process.env.FEATURE_FLAG_CHECK?.trim() ? new RegExp(process.env.FEATURE_FLAG_CHECK.trim(), 'u') : null;
  } catch {
    return null;
  }
}

// Why one cited check does not hold, or null when it does.
async function gateProblem(lineOf, files, check, gate) {
  const { path, line, flag } = gate ?? {};
  if (typeof path !== 'string' || !Number.isInteger(line) || typeof flag !== 'string' || !flagName.test(flag)) {
    return 'The AI review cited a feature flag check without its file, line, and flag.';
  }
  const where = `${path}:${line}`;
  let text;
  try {
    text = await lineOf(path, line);
  } catch {
    return `Could not read ${where} to verify the feature flag check the AI review cited.`;
  }
  if (typeof text !== 'string' || !check.test(text) || !quotes(text, flag)) {
    return `The AI review cited ${where} as a check of the ${flag} feature flag, but it is not one.`;
  }
  const file = files.get(path);
  if (file && (file.status === 'added' || typeof file.patch !== 'string' || addedLines(file.patch).has(line))) {
    return `Adds or changes the check of the ${flag} feature flag it relies on (${where}).`;
  }
  return null;
}

// Reads lines of the head revision, each file once.
function headLines(github, context) {
  const sha = context.payload.pull_request.head.sha;
  const read = new Map();
  return async (path, line) => {
    if (!read.has(path)) {
      read.set(
        path,
        github.rest.repos.getContent({ ...context.repo, path, ref: sha }).then(({ data }) => {
          if (Array.isArray(data) || data.encoding !== 'base64') throw new Error(`${path} is not a readable file`);
          return Buffer.from(data.content, 'base64').toString('utf8').split('\n');
        }),
      );
    }
    return (await read.get(path))[line - 1];
  };
}

// Why the reviews' clearing of a self-approver's PR does not hold, as at most
// one reason for a person, or none. Only a review that needs no person under a
// scope behind a feature flag is checked.
async function flagReasons({ github, context }, reviewers) {
  const pr = context.payload.pull_request;
  const own = selfApproverOf(pr.user);
  if (!own || own.flagged.length === 0) return [];
  const clearing = parsed(reviewers)
    .filter((e) => completed(e.result, e.review) && e.review.human_review?.needed === false)
    .map((e) => e.review.human_review);
  const gates = [];
  for (const { within, flag_gates: cited } of clearing) {
    if (!Number.isInteger(within) || within < 1 || within > own.scopes.length) {
      return [`The AI review did not say which change ${pr.user.login} may merge without a person this is.`];
    }
    if (!own.flagged.includes(own.scopes[within - 1])) continue;
    if (!Array.isArray(cited) || cited.length === 0) {
      return ['The AI review cited no feature flag check that keeps this change off.'];
    }
    gates.push(...cited.slice(0, 20));
  }
  if (gates.length === 0) return [];
  const check = flagCheck();
  if (!check) return ['This repository names no feature flag check, so the cited checks could not be verified.'];
  let files;
  try {
    files = await github.paginate(github.rest.pulls.listFiles, {
      ...context.repo,
      pull_number: pr.number,
      per_page: 100,
    });
  } catch {
    return ['Could not list the changed files to verify the feature flag checks.'];
  }
  if (files.length >= 3000)
    return ['Changes more files than GitHub lists, so the feature flag checks were not verified.'];
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const lineOf = headLines(github, context);
  for (const gate of gates) {
    const problem = await gateProblem(lineOf, byPath, check, gate);
    if (problem) return [problem];
  }
  return [];
}

module.exports = { addedLines, flagReasons };
