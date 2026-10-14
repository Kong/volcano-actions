'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { canWrite } = require('./github.cjs');

// GitHub logins: letters, digits, and single inner hyphens.
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;

// The candidate logins the review job found, most history first.
function reviewerCandidates() {
  try {
    const logins = JSON.parse(process.env.REVIEWER_CANDIDATES || '[]');
    return Array.isArray(logins) ? logins.filter((l) => typeof l === 'string' && loginPattern.test(l)) : [];
  } catch {
    return [];
  }
}

const git = (...args) =>
  execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

const addCounts = (into, from) => {
  for (const [file, count] of from) into.set(file, (into.get(file) ?? 0) + count);
};

// Each commit author's email with their latest commit and how often they
// changed each of the files.
function historyByEmail(base, changed) {
  const people = new Map();
  if (changed.length === 0) return people;
  const wanted = new Set(changed);
  const log = git(
    'log',
    '-n',
    '500',
    '--since=1.year',
    '--no-merges',
    '--format=%x1e%H %ae',
    '--name-only',
    base,
    '--',
    ...changed,
  );
  for (const record of log.split('\u001E').slice(1)) {
    const [header, ...names] = record.split('\n');
    const [sha, email] = header.split(' ');
    const files = names.filter((name) => wanted.has(name));
    if (!email || files.length === 0) continue;
    // The log runs newest first, so each person keeps their latest commit.
    const person = people.get(email) ?? { sha, commits: 0, files: new Map() };
    person.commits += 1;
    addCounts(
      person.files,
      files.map((file) => [file, 1]),
    );
    people.set(email, person);
  }
  return people;
}

const byCommits = (a, b) => b.commits - a.commits;

// Several emails can belong to one login, so merge them by login.
async function historyByLogin(github, context, people, author) {
  const byLogin = new Map();
  for (const person of [...people.values()].sort(byCommits).slice(0, 10)) {
    const { data } = await github.rest.repos.getCommit({ ...context.repo, ref: person.sha });
    const login = data.author?.login;
    if (!login || data.author.type !== 'User' || login === author || !loginPattern.test(login)) continue;
    const merged = byLogin.get(login) ?? { login, commits: 0, files: new Map() };
    merged.commits += person.commits;
    addCounts(merged.files, person.files);
    byLogin.set(login, merged);
  }
  return [...byLogin.values()].sort(byCommits);
}

async function findCandidates(github, context) {
  const { base, head, user } = context.payload.pull_request;
  const changed = git('diff', '--name-only', '-z', '--no-renames', `${base.sha}...${head.sha}`)
    .split('\0')
    .filter(Boolean)
    .slice(0, 300);
  const found = [];
  for (const person of await historyByLogin(github, context, historyByEmail(base.sha, changed), user.login)) {
    if (found.length === 5) break;
    if (!(await canWrite(github, context, person.login))) continue;
    const files = [...person.files]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file]) => file);
    found.push({ login: person.login, commits: person.commits, files });
  }
  return found;
}

// Finds who to suggest as the human reviewer: the people with the most recent
// commits to the changed files, which the review job runs before Claude in
// its base checkout. Only the base branch's history counts, since the PR's
// own commits can name any author. Drops the PR author, bots, and anyone
// without write access, who could not approve. Writes reviewers.jsonl for
// Claude and the logins for publish; a failure only leaves both empty.
async function candidates({ github, context, core }) {
  let found = [];
  try {
    found = await findCandidates(github, context);
  } catch (error) {
    core.warning(`Could not find reviewer candidates: ${error.message}`);
  }
  const dir = path.join(process.env.RUNNER_TEMP, 'claude-review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewers.jsonl'), found.map((f) => `${JSON.stringify(f)}\n`).join(''));
  core.setOutput('candidates', JSON.stringify(found.map((f) => f.login)));
}

module.exports = { reviewerCandidates, candidates };
