'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { severities } = require('./claude-review.cjs');
const { readRepo, action } = require('./test-helpers.cjs');

const workflow = () => readRepo('.github/workflows/claude-review.yml');
const jobsOf = (text) =>
  Object.fromEntries(
    text
      .split('\njobs:\n')[1]
      .split(/\n(?=  [a-z-]+:\n)/u)
      .map((job) => [job.match(/^ {2}([a-z-]+):/u)[1], job]),
  );
const stepsOf = (job) => job.split('\n    steps:\n')[1];
// The text of a step from its first line to the next step or comment above one.
const stepText = (job, marker) => {
  const body = stepsOf(job);
  const from = body.indexOf(marker);
  const next = body.slice(from + 1).search(/\n {6}[-#]/u);
  return body.slice(from, next === -1 ? undefined : from + 1 + next);
};

test('the codex job reviews with read access only, after start decides a review is due', () => {
  const { codex } = jobsOf(workflow());
  assert.match(codex, /\n {4}needs: start\n {4}if: needs\.start\.outputs\.review == 'true'\n/u);
  assert.match(codex, /\n {4}permissions:\n {6}contents: read\n(?: {6}#.*\n)? {6}pull-requests: read\n {4}outputs:\n/u);
  assert.doesNotMatch(codex, /: write|id-token/u);
  // Only prepare holds the job token; Codex's own step never sees it.
  const withoutPrepare = codex.replace(stepText(codex, '- name: Prepare review inputs'), '');
  assert.doesNotMatch(withoutPrepare, /github\.token/u);
  assert.deepEqual(codex.match(/ ref: .*/gu), [' ref: ${{ github.event.pull_request.base.sha }}']);
  assert.match(codex, /\n {6}findings: \$\{\{ steps\.codex\.outputs\.final-message \}\}\n/u);
});

test('the codex job prepares the same inputs as the Claude job', () => {
  const { review, codex } = jobsOf(workflow());
  const prepare = (job) => stepText(job, '- name: Prepare review inputs');
  assert.ok(prepare(review).includes('git worktree add --quiet --detach'));
  assert.equal(prepare(codex), prepare(review));
});

test('the codex job requires its key and drops the checkout credentials before Codex starts', () => {
  const { codex } = jobsOf(workflow());
  const guard = stepText(codex, '- name: Require the API key');
  assert.match(guard, /KEY_SET: \$\{\{ secrets\.openai_api_key != '' \}\}\n/u);
  assert.match(guard, /exit 1\n/u);
  const body = codex.split('\n    steps:\n')[1];
  const order = [
    '- name: Require the API key',
    '- name: Prepare review inputs',
    '- name: Drop the checkout credentials',
    '- id: codex',
  ];
  const at = order.map((marker) => body.indexOf(marker));
  assert.ok(
    at.every((i) => i >= 0),
    at.join(','),
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
  );
  const drop = stepText(codex, '- name: Drop the checkout credentials');
  assert.match(drop, /rm -f "\$RUNNER_TEMP"\/git-credentials-\*\.config\n/u);
  assert.match(drop, /--unset-all "\$key"/u);
});

test('Codex runs pinned, read-only, and keyed by the caller', () => {
  const run = stepText(jobsOf(workflow()).codex, '- id: codex');
  assert.match(run, /\n {8}uses: openai\/codex-action@[a-f0-9]{40} # v[\d.]+\n/u);
  assert.match(run, /\n {10}openai-api-key: \$\{\{ secrets\.openai_api_key \}\}\n/u);
  assert.match(run, /\n {10}codex-version: \d+\.\d+\.\d+\n/u);
  assert.match(run, /\n {10}permission-profile: ':read-only'\n/u);
  // The default drop-sudo strategy; `unsafe` or a legacy sandbox would widen access.
  assert.doesNotMatch(run, /safety-strategy|sandbox:|codex-args|--full-auto|danger/u);
  assert.match(run, /\n {10}allow-bot-users: \$\{\{ inputs\.allowed_bots \}\}\n/u);
  assert.match(run, /\n {8}timeout-minutes: 40\n/u);
});

test("Codex's output schema is Claude's without maxLength", () => {
  const text = workflow();
  const run = stepText(jobsOf(text).codex, '- id: codex');
  const codex = JSON.parse(run.match(/\n {10}output-schema: '(.*)'\n/u)[1]);
  const claude = JSON.parse(text.match(/\n {12}--json-schema '(.*)'\n/u)[1]);
  const strip = (node) =>
    Array.isArray(node)
      ? node.map((v) => strip(v))
      : node && typeof node === 'object'
        ? Object.fromEntries(
            Object.entries(node)
              .filter(([key]) => key !== 'maxLength')
              .map(([key, v]) => [key, strip(v)]),
          )
        : node;
  assert.deepEqual(codex, strip(claude));
  assert.doesNotMatch(JSON.stringify(codex), /maxLength/u);
  assert.deepEqual(codex.properties.findings.items.properties.severity.enum, Object.keys(severities));
});

test("Codex's prompt shares Claude's review policy word for word", () => {
  const { review, codex } = jobsOf(workflow());
  const from = 'A claim that the change breaks other code must name that code.';
  const policy = review.slice(review.indexOf(from), review.indexOf('Earlier runs may already have commented'));
  for (const part of [
    '- p0: Drop everything.',
    'Separately from findings',
    'Set not_checked',
    'reviewed_closely',
    'reviewers.jsonl lists',
  ]) {
    assert.ok(policy.includes(part), part);
  }
  assert.ok(codex.includes(policy));
  assert.match(codex, /\n {12}\$\{\{ inputs\.focus \}\}\n/u);
  // Codex posts no inline comments; its findings go in the summary comment.
  assert.doesNotMatch(codex.slice(codex.indexOf('prompt: |')), /inline comment|mcp__/u);
});

test('one verdict job publishes once both reviewers finish', () => {
  const job = jobsOf(workflow()).verdict;
  assert.match(job, /\n {4}needs: \[review, codex\]\n/u);
  const condition = job
    .match(/\n {4}if: >-\n((?: {6}.*\n)+)/u)[1]
    .replaceAll(/\s+/gu, ' ')
    .trim();
  assert.equal(
    condition,
    `always() && (contains(fromJSON('["success","failure"]'), needs.review.result) || contains(fromJSON('["success","failure"]'), needs.codex.result))`,
  );
  assert.equal(stepsOf(job).match(/\n {6}- /gu).length, 1);
  assert.ok(stepsOf(job).includes(`- uses: ${action}\n`));
  for (const line of [
    'step: publish',
    'review-result: ${{ needs.review.result }}',
    'findings: ${{ needs.review.outputs.findings }}',
    'codex-result: ${{ needs.codex.result }}',
    'codex-findings: ${{ needs.codex.outputs.findings }}',
    'reviewer-candidates: ${{ needs.review.outputs.candidates || needs.codex.outputs.candidates }}',
  ]) {
    assert.ok(job.includes(`\n          ${line}\n`), line);
  }
});

test('the codex job finds reviewer candidates before it drops the credentials', () => {
  const { review, codex } = jobsOf(workflow());
  const candidates = (job) => stepText(job, '- id: candidates');
  assert.equal(candidates(codex), candidates(review));
  const body = stepsOf(codex);
  assert.ok(body.indexOf('- id: candidates') < body.indexOf('- name: Drop the checkout credentials'));
  assert.match(codex, /\n {6}candidates: \$\{\{ steps\.candidates\.outputs\.candidates \}\}\n/u);
});
