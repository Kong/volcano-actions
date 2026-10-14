'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { statusContext, humanStatusContext } = require('./ai-review.cjs');
const { readRepo } = require('./test-helpers.cjs');
const { tempDir } = require('./test-git.cjs');

test('the merge queue passes the same statuses without a checkout or OIDC token', () => {
  const workflow = readRepo('.github/workflows/ai-review-merge-queue.yml');
  assert.match(workflow, /\non:\n {2}workflow_call:\n/u);
  assert.match(workflow, /if: github\.event_name == 'merge_group'\n/u);
  assert.match(workflow, new RegExp(`\\n {10}for status in ${statusContext} ${humanStatusContext}; do\\n`, 'u'));
  assert.match(workflow, /state=success -f context="\$status" /u);
  assert.doesNotMatch(workflow, /actions\/checkout|id-token|pull_request/u);
});

// Runs the merge queue's step with a gh that fails its first `failures` calls.
function passMergeGroup(t, failures) {
  const workflow = readRepo('.github/workflows/ai-review-merge-queue.yml');
  const script = workflow
    .split('- name: Pass the merge group\n')[1]
    .split('run: |\n')[1]
    .replaceAll(/^ {10}/gmu, '');
  const dir = tempDir(t, 'ai-review-');
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    path.join(dir, 'gh'),
    [
      '#!/bin/sh',
      `echo "$*" >> '${calls}'`,
      `[ "$(wc -l < '${calls}')" -gt ${failures} ] || { echo 'unexpected end of JSON input' >&2; exit 1; }`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });
  let code = 0;
  try {
    execFileSync('bash', ['-e', '-c', script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REPO: 'Kong/volcano-hosting', SHA: 'abc123' },
      stdio: 'pipe',
    });
  } catch (error) {
    code = error.status;
  }
  const posted = fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.match(/context=(\S+)/u)[1]);
  return { code, posted };
}

test('the merge queue retries a status post that fails', (t) => {
  assert.deepEqual(passMergeGroup(t, 0), { code: 0, posted: [statusContext, humanStatusContext] });
  assert.deepEqual(passMergeGroup(t, 2), {
    code: 0,
    posted: [statusContext, statusContext, statusContext, humanStatusContext],
  });
  // Five failures in a row fail the job rather than skip a status.
  assert.deepEqual(passMergeGroup(t, 5), { code: 1, posted: Array.from({ length: 5 }, () => statusContext) });
});
