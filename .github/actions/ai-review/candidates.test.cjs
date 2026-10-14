'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { prepare } = require('./ai-review.cjs');
const { client, context, core } = require('./test-helpers.cjs');
const { tempDir, scratchRepo } = require('./test-git.cjs');

// Builds a repository whose base history has several authors.
function history(t) {
  const dir = tempDir(t, 'ai-review-candidates-');
  const { repo, commit: commitAs } = scratchRepo(dir);
  const logins = {};
  const commit = (author, files) => {
    const head = commitAs(files, `${author} change`, author);
    logins[head] = author;
    return head;
  };
  for (let i = 0; i < 3; i++) commit('alice', { 'billing/a.go': `a${i}\n`, 'billing/b.go': `b${i}\n` });
  commit('alice-old', { 'billing/a.go': 'old\n' });
  commit('bob', { 'billing/a.go': 'bob\n', 'docs/x.md': 'x\n' });
  commit('bob', { 'docs/x.md': 'y\n' });
  commit('reader', { 'billing/a.go': 'reader\n' });
  commit('author', { 'billing/a.go': 'mine\n' });
  commit('dependabot', { 'billing/a.go': 'bump\n' });
  commit('carol', { 'other/z.go': 'z\n' });
  const base = commit('unlinked', { 'billing/a.go': 'unlinked\n' });
  // The PR's own commits never count.
  const head = commit('mallory', { 'billing/a.go': 'pr\n', 'docs/x.md': 'pr\n', 'new/file.go': 'new\n' });
  return { dir, repo, base, head, logins };
}

const users = {
  'alice-old': 'alice',
  reader: 'reader',
  author: 'author',
  alice: 'alice',
  bob: 'bob',
  carol: 'carol',
  mallory: 'mallory',
};
const commitAuthorIn = (logins) => (ref) => {
  const who = logins[ref];
  if (who === 'dependabot') return { login: 'dependabot[bot]', type: 'Bot' };
  return users[who] ? { login: users[who], type: 'User' } : null;
};

// Runs prepare's candidates against the repository as a reviewer job would,
// after its checkout and prepare.sh.
async function findCandidates({ dir, repo, base, head, logins }, options = {}) {
  const c = client({ commitAuthor: commitAuthorIn(logins), permissions: { reader: 'read' }, ...options });
  const k = core();
  const pr = {
    number: 7,
    user: { login: 'author' },
    base: { ref: 'main', sha: base },
    head: { sha: head, repo: { full_name: 'Kong/volcano-hosting' } },
  };
  const saved = { INPUTS: process.env.INPUTS, GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE };
  process.env.INPUTS = path.join(dir, 'ai-review');
  process.env.GITHUB_WORKSPACE = repo;
  try {
    await prepare({ github: c.github, context: { ...context(), payload: { pull_request: pr } }, core: k });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const file = fs.readFileSync(path.join(dir, 'ai-review', 'reviewers.jsonl'), 'utf8');
  return {
    k,
    c,
    logins: JSON.parse(k.outputs.candidates),
    file: file
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test('candidates are the writers with the most base history in the changed files', async (t) => {
  const repo = history(t);
  const { k, c, logins: found, file } = await findCandidates(repo);
  assert.deepEqual(k.warnings, []);
  // alice's two emails merge; reader cannot approve; the author, a bot, an
  // unlinked email, someone outside the changed files, and the PR's own
  // author drop out.
  assert.deepEqual(found, ['alice', 'bob']);
  assert.deepEqual(file, [
    { login: 'alice', commits: 4, files: ['billing/a.go'] },
    { login: 'bob', commits: 2, files: ['docs/x.md', 'billing/a.go'] },
  ]);
  assert.ok(!c.named('getCommit').some((g) => g.ref === repo.head));

  // A failure leaves no candidates rather than failing the review.
  const broken = await findCandidates(repo, {
    commitAuthor: () => {
      throw new Error('Server Error');
    },
  });
  assert.deepEqual(broken.logins, []);
  assert.deepEqual(broken.file, []);
  assert.match(broken.k.warnings[0], /Could not find reviewer candidates: Server Error/u);
});
