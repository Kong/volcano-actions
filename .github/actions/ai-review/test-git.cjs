'use strict';

// Temporary directories and scratch git repositories for the ai-review tests.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A temporary directory removed after the test.
function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Git with no global or system config, committing as `author`.
const gitEnv = (author = 't') => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: author,
  GIT_AUTHOR_EMAIL: `${author}@example.com`,
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
});

// Writes text or bytes, deletes null entries, and links { symlink } entries.
// Returns the { gitlink } entries, which only the index can hold.
function writeFiles(repo, files) {
  const gitlinks = [];
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(repo, file);
    if (text?.gitlink) {
      gitlinks.push([file, text.gitlink]);
    } else if (text === null) {
      fs.rmSync(target);
    } else if (text.symlink) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(text.symlink, target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }
  return gitlinks;
}

// A new repository at dir/repo; each commit returns its SHA.
function scratchRepo(dir) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (args, author) => execFileSync('git', args, { cwd: repo, env: gitEnv(author), encoding: 'utf8' }).trim();
  git(['init', '-q']);
  const commit = (files, message, author) => {
    const gitlinks = writeFiles(repo, files);
    git(['add', '-A'], author);
    for (const [file, link] of gitlinks)
      git(['update-index', '--add', '--cacheinfo', `160000,${link},${file}`], author);
    git(['commit', '-qm', message], author);
    return git(['rev-parse', 'HEAD'], author);
  };
  return { repo, git, commit };
}

const lstatIn = (dir) => (file) => {
  try {
    return fs.lstatSync(path.join(dir, file));
  } catch {
    return null;
  }
};
const readIn = (dir) => (file) => (lstatIn(dir)(file) ? fs.readFileSync(path.join(dir, file), 'utf8') : null);

// Runs prepare.sh against a real repository whose head edits, adds, and
// deletes instruction files.
function prepare(t, { base, head }) {
  const dir = tempDir(t, 'ai-review-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho \'{"path":"main.go","line":1}\'\n', { mode: 0o755 });
  const { repo, git, commit } = scratchRepo(dir);
  const baseSha = commit(base, 'base');
  const headSha = commit(head, 'feat: change under review');
  // The workflow checks out the base at the workspace root.
  git(['checkout', '-q', '--detach', baseSha]);
  const inputs = path.join(dir, 'inputs');
  execFileSync('bash', [path.join(__dirname, 'prepare.sh')], {
    cwd: repo,
    env: {
      ...gitEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      INPUTS: inputs,
      REPO: 'Kong/volcano-hosting',
      PR_NUMBER: '7',
    },
  });
  const input = (file) => fs.readFileSync(path.join(inputs, file), 'utf8');
  const headDir = path.join(inputs, 'head');
  return { read: readIn(repo), input, readHead: readIn(headDir), lstatHead: lstatIn(headDir) };
}

module.exports = { tempDir, scratchRepo, prepare };
