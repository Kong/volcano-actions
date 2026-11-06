'use strict';

const { globRegExp } = require('./paths.cjs');

// A repository can name owners for its paths in OWNERS, one line each in
// CODEOWNERS syntax, such as `/apps/web/ @octocat @hubot`. When a PR needs a
// person, the human status then counts only an approval from one owner of
// each owned path it changes, as a required code owner review would. A PR
// that needs no person is unaffected, so a self-approval still holds (see
// self-approval.cjs). As in CODEOWNERS, a file's owners are those of the last
// line that matches it, and a line with no owners leaves its paths unowned.
// Owners are user logins: team handles and emails are skipped with a warning,
// since the workflow token cannot read team membership. The PR author never
// counts as an owner, so a path only its author owns takes any approval.

const loginPattern = /^[A-Za-z0-9-]+$/u;

// A CODEOWNERS path as globs (see paths.cjs): a leading `/` or an inner one
// anchors it at the root, otherwise it matches at any depth; a trailing `/`
// means a directory; and a path also covers what is under it.
function ownerPatterns(path) {
  const anchored = path.startsWith('/') || path.replace(/\/$/u, '').includes('/');
  let glob = path.replace(/^\//u, '');
  if (glob.endsWith('/')) glob += '**';
  if (!anchored) glob = `**/${glob}`;
  return [globRegExp(glob), globRegExp(`${glob}/**`)];
}

function ownerLines(core) {
  return (process.env.OWNERS || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [path, ...owners] = line.split(/\s+/u);
      const logins = owners.map((o) => o.replace(/^@/u, ''));
      for (const skipped of owners.filter((o, i) => !loginPattern.test(logins[i]))) {
        core?.warning(`The owners line for ${path} names ${skipped}, which is not a user login, so it is skipped.`);
      }
      return { patterns: ownerPatterns(path), logins: logins.filter((l) => loginPattern.test(l)) };
    });
}

// The owners a PR's approval must come from, as [{ path, logins }]: one group
// for each distinct set of owners among the changed paths, named by one of
// them. A rename counts at both paths. When the files cannot be listed, any
// owner stands for them all.
async function ownerGroups({ github, context, core }, pull) {
  const lines = ownerLines(core);
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
    const logins = others(lines.findLast((l) => l.patterns.some((p) => p.test(path)))?.logins ?? []);
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
