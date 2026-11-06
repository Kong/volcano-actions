'use strict';

const { globRegExp } = require('./paths.cjs');

// A repository can name owners for its paths in OWNERS, one line each, as a
// glob and their logins, such as `apps/web/** @octocat @hubot`. When a PR
// needs a person, the human status then counts only an approval from one
// owner of each owned path it changes, as a required code owner review would.
// A PR that needs no person is unaffected, so a self-approval still holds (see
// self-approval.cjs). As in CODEOWNERS, a file's owners are those of the last
// line that matches it, and a line with no logins leaves its paths unowned.
// Globs match as in human_review_paths. The PR author never counts as an
// owner, so a path only its author owns takes any approval.

const loginPattern = /^[A-Za-z0-9-]+$/u;

function ownerLines() {
  return (process.env.OWNERS || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [glob, ...logins] = line.split(/\s+/u);
      return {
        pattern: globRegExp(glob),
        logins: logins.map((l) => l.replace(/^@/u, '')).filter((l) => loginPattern.test(l)),
      };
    });
}

// The owners a PR's approval must come from, as [{ path, logins }]: one group
// for each distinct set of owners among the changed paths, named by one of
// them. A rename counts at both paths. When the files cannot be listed, any
// owner stands for them all.
async function ownerGroups(github, context, pull) {
  const lines = ownerLines();
  if (lines.length === 0) return [];
  const others = (logins) => logins.filter((l) => l.toLowerCase() !== pull.user.login.toLowerCase());
  let files;
  try {
    files = await github.paginate(github.rest.pulls.listFiles, {
      ...context.repo,
      pull_number: pull.number,
      per_page: 100,
    });
    if (files.length >= 3000) throw new Error('GitHub lists at most 3000 files');
  } catch {
    const anyone = others([...new Set(lines.flatMap((l) => l.logins))]);
    return anyone.length > 0 ? [{ path: 'the changed files', logins: anyone }] : [];
  }
  const groups = new Map();
  for (const path of new Set(files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean))) {
    const logins = others(lines.findLast((l) => l.pattern.test(path))?.logins ?? []);
    const key = logins
      .map((l) => l.toLowerCase())
      .sort()
      .join(',');
    if (logins.length > 0 && !groups.has(key)) groups.set(key, { path, logins });
  }
  return [...groups.values()];
}

// The groups none of `approvers` belongs to.
const owed = (groups, approvers) =>
  groups.filter((g) => !approvers.some((a) => g.logins.some((l) => l.toLowerCase() === a.login.toLowerCase())));

module.exports = { ownerGroups, owed };
