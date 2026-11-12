'use strict';

// Fixtures and a GitHub fake shared by the cost and ledger tests.

const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./test-git.cjs');
const { sha } = require('./test-helpers.cjs');

const tokens = (input, output, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
});
const claudeUsage = {
  provider: 'claude',
  attempt: 1,
  models: { 'claude-opus-5-5': { calls: 3, tokens: tokens(1e6, 1e5, 2e6) } },
};
const codexUsage = { provider: 'codex', attempt: 1, models: { 'gpt-6.1-sol': { calls: 2, tokens: tokens(1e6, 1e5) } } };
const needs = (claude, codex = claude, extra = {}) =>
  JSON.stringify({
    claude: { result: claude, outputs: claude === 'skipped' ? {} : { reviewer: 'Claude', model: 'claude-opus-5-5' } },
    codex: { result: codex, outputs: codex === 'skipped' ? {} : { reviewer: 'Codex', model: 'gpt-6.1-sol' } },
    ...extra,
  });
function usageDir(t, files = null) {
  const dir = tempDir(t, 'usage-');
  for (const [id, usage] of Object.entries(files ?? { claude: claudeUsage, codex: codexUsage })) {
    fs.writeFileSync(path.join(dir, `ai-review-usage-${id}.json`), JSON.stringify(usage));
  }
  return dir;
}

// Answers like an Octokit method: always a promise.
const resolved =
  (fn) =>
  (...args) =>
    Promise.resolve(fn(...args));

// A PR's issue comments that the cost step reads and writes.
function commentsClient(initial = []) {
  let comments = initial.map((c) => ({ ...c }));
  let next = 100;
  const calls = [];
  const github = {
    paginate: resolved(() => comments.map((c) => ({ ...c }))),
    rest: {
      issues: {
        listComments: () => {},
        getComment: resolved(({ comment_id: id }) => {
          const comment = comments.find((c) => c.id === id);
          if (!comment) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { ...comment } };
        }),
        createComment: resolved(({ body }) => {
          calls.push('create');
          comments.push({ id: (next += 1), user: { login: 'github-actions[bot]' }, body });
          return { data: {} };
        }),
        updateComment: resolved(({ comment_id: id, body }) => {
          calls.push('update');
          comments = comments.map((c) => (c.id === id ? { ...c, body } : c));
          return { data: {} };
        }),
        deleteComment: resolved(({ comment_id: id }) => {
          calls.push('delete');
          if (!comments.some((c) => c.id === id)) throw Object.assign(new Error('Not Found'), { status: 404 });
          comments = comments.filter((c) => c.id !== id);
          return { data: {} };
        }),
      },
      pulls: { get: resolved(() => ({ data: { head: { sha: 'fedcba9876543210' } } })) },
    },
  };
  return { github, calls, comments: () => comments };
}
const noWait = { wait: () => Promise.resolve() };
const round = (state, claude, codex, at, partial = state === 'cancelled', unknown = []) => ({
  sha,
  at,
  state,
  partial,
  unknown,
  by: { Claude: claude, Codex: codex },
});

module.exports = { tokens, claudeUsage, codexUsage, needs, usageDir, resolved, commentsClient, noWait, round };
