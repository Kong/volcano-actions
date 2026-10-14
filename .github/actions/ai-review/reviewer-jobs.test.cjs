'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { reviewWorkflow, action, jobsOf, stepsOf, stepText, outputsOf, reviewerJobs } = require('./test-workflow.cjs');

// Each reviewer job's provider step and the API key secret it calls with.
const providers = {
  claude: { step: '- id: claude', secret: 'anthropic_api_key' },
  codex: { step: '- id: codex', secret: 'openai_api_key' },
};
const prepare = `- id: prepare\n        uses: ${action}\n        with:\n          step: prepare\n          focus: \${{ inputs.focus }}\n`;

test('every job with a reviewer output is in verdict.needs, and every job it needs is a reviewer', () => {
  const jobs = jobsOf(reviewWorkflow());
  const needs = jobs.verdict.match(/\n {4}needs: \[(.*)\]\n/u)[1].split(', ');
  assert.deepEqual(reviewerJobs(jobs), needs);
  assert.deepEqual(Object.keys(providers), needs);
});

test('every reviewer job names itself and reports its findings and candidates', () => {
  const jobs = jobsOf(reviewWorkflow());
  for (const name of reviewerJobs(jobs)) {
    const outputs = outputsOf(jobs[name]);
    assert.deepEqual(Object.keys(outputs), ['reviewer', 'findings', 'candidates'], name);
    // A static name, which the summary comment shows.
    assert.match(outputs.reviewer, /^[A-Z][\w ]*$/u, name);
    const id = providers[name].step.slice('- id: '.length);
    assert.match(outputs.findings, new RegExp(`^\\$\\{\\{ steps\\.${id}\\.outputs\\.[\\w-]+ \\}\\}$`, 'u'), name);
    assert.equal(outputs.candidates, '${{ steps.prepare.outputs.candidates }}', name);
  }
});

test('every reviewer job requires its key, then prepares the base checkout with the action', () => {
  const jobs = jobsOf(reviewWorkflow());
  for (const name of reviewerJobs(jobs)) {
    const { step, secret } = providers[name];
    const steps = stepsOf(jobs[name]);
    // A missing key fails the job, so the other reviewers' verdict stands.
    const guard = stepText(jobs[name], '- name: Require the API key');
    assert.equal(steps.match(/^ {6}- (.*)$/mu)[1], 'name: Require the API key', name);
    assert.match(guard, new RegExp(`\\n {10}KEY_SET: \\$\\{\\{ secrets\\.${secret} != '' \\}\\}\\n`, 'u'), name);
    assert.match(guard, /exit 1\n/u, name);
    // The base sits at the workspace root; prepare puts the head beside it as data.
    assert.deepEqual(jobs[name].match(/ ref: .*/gu), [' ref: ${{ github.event.pull_request.base.sha }}'], name);
    assert.equal(jobs[name].match(/actions\/checkout@/gu).length, 1, name);
    assert.ok(steps.includes(prepare), name);
    const order = ['- name: Require the API key', 'actions/checkout@', '- id: prepare', step].map((m) =>
      steps.indexOf(m),
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      name,
    );
    assert.ok(!order.includes(-1), name);
    assert.match(stepText(jobs[name], step), new RegExp(`: \\$\\{\\{ secrets\\.${secret} \\}\\}\\n`, 'u'), name);
  }
});

test('every reviewer gets the shared policy first and a schema from prepare', () => {
  const jobs = jobsOf(reviewWorkflow());
  for (const name of reviewerJobs(jobs)) {
    const run = stepText(jobs[name], providers[name].step);
    assert.match(run, /\n {10}prompt: \|\n {12}\$\{\{ steps\.prepare\.outputs\.policy \}\}\n\n/u, name);
    assert.match(run, /\$\{\{ steps\.prepare\.outputs\.schema(?:-without-max-length)? \}\}/u, name);
    // The policy is the one place a review's rules live.
    assert.doesNotMatch(run, /- p0: |Separately from findings|reviewers\.jsonl lists|\$\{\{ inputs\.focus \}\}/u, name);
  }
  const claude = stepText(jobs.claude, providers.claude.step);
  // The schema rides in single quotes in claude_args; prepare's has none.
  assert.match(claude, /\n {12}--json-schema '\$\{\{ steps\.prepare\.outputs\.schema \}\}'\n/u);
  assert.match(claude, /\n {12}--add-dir \$\{\{ steps\.prepare\.outputs\.inputs \}\}\n/u);
  assert.match(claude, /\$\{\{ steps\.prepare\.outputs\.inputs \}\}\/review-comments\.jsonl lists the\n/u);
  assert.match(claude, /pass `\$\{\{ github\.event\.pull_request\.head\.sha \}\}` as `commit_id`/u);
  const codex = stepText(jobs.codex, providers.codex.step);
  // OpenAI's structured outputs reject maxLength.
  assert.match(codex, /\n {10}output-schema: \$\{\{ steps\.prepare\.outputs\.schema-without-max-length \}\}\n/u);
  // Codex posts no inline comments; its findings go in the summary comment.
  assert.doesNotMatch(codex.slice(codex.indexOf('prompt: |')), /inline comment|mcp__|review-comments/u);
});

test('a hung reviewer fails its job instead of leaving the head pending', () => {
  const jobs = jobsOf(reviewWorkflow());
  for (const name of reviewerJobs(jobs)) {
    const job = Number(jobs[name].match(/\n {4}timeout-minutes: (\d+)\n/u)[1]);
    const run = stepText(jobs[name], providers[name].step);
    const step = Number(run.match(/\n {8}timeout-minutes: (\d+)\n/u)[1]);
    assert.ok(step < job, `${name}: step ${step} must time out before job ${job}`);
  }
});

test('the codex job reviews with read access only and drops the credentials before Codex starts', () => {
  const { codex } = jobsOf(reviewWorkflow());
  assert.match(codex, /\n {4}permissions:\n {6}contents: read\n(?: {6}#.*\n)? {6}pull-requests: read\n {4}outputs:\n/u);
  assert.doesNotMatch(codex, /: write|id-token|github\.token/u);
  const steps = stepsOf(codex);
  assert.ok(steps.indexOf('- id: prepare') < steps.indexOf('- name: Drop the checkout credentials'));
  assert.ok(steps.indexOf('- name: Drop the checkout credentials') < steps.indexOf('- id: codex'));
  const drop = stepText(codex, '- name: Drop the checkout credentials');
  assert.match(drop, /rm -f "\$RUNNER_TEMP"\/git-credentials-\*\.config\n/u);
  assert.match(drop, /--unset-all "\$key"/u);
});

test('Codex runs pinned and read-only', () => {
  const run = stepText(jobsOf(reviewWorkflow()).codex, providers.codex.step);
  assert.match(run, /\n {8}uses: openai\/codex-action@[a-f0-9]{40} # v[\d.]+\n/u);
  assert.match(run, /\n {10}codex-version: \d+\.\d+\.\d+\n/u);
  assert.match(run, /\n {10}permission-profile: ':read-only'\n/u);
  // The default drop-sudo strategy; `unsafe` or a legacy sandbox would widen access.
  assert.doesNotMatch(run, /safety-strategy|sandbox:|codex-args|--full-auto|danger/u);
});

test('one verdict job publishes every reviewer once any of them finishes', () => {
  const job = jobsOf(reviewWorkflow()).verdict;
  assert.match(
    job,
    /\n {4}if: always\(\) && \(contains\(needs\.\*\.result, 'success'\) \|\| contains\(needs\.\*\.result, 'failure'\)\)\n/u,
  );
  assert.equal(stepsOf(job).match(/\n {6}- /gu).length, 1);
  assert.ok(stepsOf(job).includes(`- uses: ${action}\n`));
  for (const line of [
    'step: publish',
    'reviews: ${{ toJSON(needs) }}',
    'human-review-paths: ${{ inputs.human_review_paths }}',
    'anthropic-api-key: ${{ secrets.anthropic_api_key }}',
    'openai-api-key: ${{ secrets.openai_api_key }}',
  ]) {
    assert.ok(job.includes(`\n          ${line}\n`), line);
  }
});
