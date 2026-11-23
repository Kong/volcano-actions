'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  reviewWorkflow,
  action,
  jobsOf,
  stepsOf,
  stepText,
  outputsOf,
  reviewerJobs,
  modelOf,
} = require('./test-workflow.cjs');

const claudeStep = '- id: claude';
const prepare = `- id: prepare\n        uses: ${action}\n        with:\n          step: prepare\n          focus: \${{ inputs.focus }}\n`;

test('Sonnet decides the verdict and the opt-in Opus job shares its read-only review steps', () => {
  const jobs = jobsOf(reviewWorkflow());
  const { claude, opus, verdict } = jobs;
  assert.deepEqual(reviewerJobs(jobs), ['claude', 'opus']);
  assert.match(verdict, /\n {4}needs: \[claude\]\n/u);
  assert.match(claude, /\n {4}if: needs\.start\.outputs\.review == 'true'\n/u);
  assert.match(opus, /\n {4}if: needs\.start\.outputs\.review == 'true' && vars\.AI_REVIEW_COMPARE_OPUS == 'true'\n/u);
  assert.match(opus, /\n {4}continue-on-error: true\n/u);
  assert.match(claude, /\n {4}steps: &claude_steps\n/u);
  assert.match(opus, /\n {4}steps: \*claude_steps\n/u);
  assert.match(
    claude,
    /\n {4}permissions: &claude_permissions\n {6}contents: read\n(?: {6}#.*\n)* {6}pull-requests: read\n/u,
  );
  assert.match(opus, /\n {4}permissions: \*claude_permissions\n/u);
  for (const name of reviewerJobs(jobs)) assert.doesNotMatch(jobs[name], /: write|mcp__/u, name);
});

test('each reviewer runs and reports its configured model', () => {
  const { claude, opus } = jobsOf(reviewWorkflow());
  assert.equal(modelOf(claude), 'claude-sonnet-5-5');
  assert.equal(modelOf(opus), 'claude-opus-5-5');
  assert.deepEqual(outputsOf(claude), {
    reviewer: 'Claude',
    model: '${{ env.REVIEW_MODEL }}',
    candidates: '${{ steps.prepare.outputs.candidates }}',
  });
  assert.deepEqual(outputsOf(opus), { reviewer: 'Claude Opus', model: '${{ env.REVIEW_MODEL }}' });
  assert.match(stepText(claude, claudeStep), /\n {12}--model \$\{\{ env\.REVIEW_MODEL \}\}\n/u);
});

test('the shared steps upload separate structured reviews and fingerprint the prepared inputs during a bake', () => {
  const { claude } = jobsOf(reviewWorkflow());
  const upload = stepText(claude, 'actions/upload-artifact@');
  assert.match(upload, /^actions\/upload-artifact@[a-f0-9]{40} # v[\d.]+\n/u);
  assert.match(upload, /\n {10}name: ai-review-\$\{\{ github\.job \}\}\n/u);
  const output = '${{ runner.temp }}/ai-review-${{ github.job }}';
  assert.ok(upload.includes(`\n          path: |\n            ${output}.json\n            ${output}.inputs.sha256\n`));
  assert.match(upload, /\n {10}if-no-files-found: error(?:\n|$)/u);
  assert.match(upload, /\n {8}timeout-minutes: \d+\n/u);
  const steps = stepsOf(claude);
  const digest = stepText(claude, '- name: Record review input digests');
  assert.match(digest, /\n {8}if: vars\.AI_REVIEW_COMPARE_OPUS == 'true'\n {8}continue-on-error: true\n/u);
  assert.match(digest, /\n {8}working-directory: \$\{\{ steps\.prepare\.outputs\.inputs \}\}\n/u);
  assert.ok(digest.includes(`\n          DIGESTS: ${output}.inputs.sha256\n`));
  assert.match(digest, /sha256sum -- pr\.diff commits\.txt description\.md comments\.jsonl review-comments\.jsonl/u);
  assert.match(digest, /previous-verdict\.md reviewers\.jsonl instructions\.txt/u);
  assert.ok(steps.indexOf('- id: prepare') < steps.indexOf(digest));
  assert.ok(steps.indexOf(digest) < steps.indexOf(claudeStep));
  const save = stepText(claude, '- name: Save the review');
  assert.match(save, /\n {10}EXECUTION_FILE: \$\{\{ steps\.claude\.outputs\.execution_file \}\}\n/u);
  assert.ok(save.includes(`\n          REVIEW: ${output}.json\n`));
  assert.match(save, /\n {8}run: jq -ce '.*\| \.structured_output' "\$EXECUTION_FILE" > "\$REVIEW"$/u);
  assert.ok(steps.indexOf(save) < steps.indexOf('actions/upload-artifact@'));
});

test('the shared steps require the credential and prepare the checked-out base before reviewing', () => {
  const { claude } = jobsOf(reviewWorkflow());
  const steps = stepsOf(claude);
  const guard = stepText(claude, '- name: Require the credential');
  assert.equal(steps.match(/^ {6}- (.*)$/mu)[1], 'name: Require the credential');
  assert.match(guard, /\n {10}KEY_SET: \$\{\{ secrets\.anthropic_api_key != '' \}\}\n/u);
  assert.match(guard, /exit 1\n/u);
  assert.deepEqual(claude.match(/ ref: .*/gu), [' ref: ${{ github.event.pull_request.base.sha }}']);
  assert.equal(steps.match(/actions\/checkout@/gu).length, 1);
  assert.ok(steps.includes(prepare));
  const order = ['- name: Require the credential', 'actions/checkout@', '- id: prepare', claudeStep].map((marker) =>
    steps.indexOf(marker),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.ok(!order.includes(-1));
  assert.match(stepText(claude, claudeStep), /anthropic_api_key: \$\{\{ secrets\.anthropic_api_key \}\}\n/u);
});

test('both models get the shared policy and schema and observe the existing bot policy', () => {
  const { claude } = jobsOf(reviewWorkflow());
  const run = stepText(claude, claudeStep);
  assert.match(run, /\n {10}prompt: \|\n {12}\$\{\{ steps\.prepare\.outputs\.policy \}\}\n\n/u);
  assert.doesNotMatch(run, /- p0: |Separately from findings|reviewers\.jsonl lists|\$\{\{ inputs\.focus \}\}/u);
  assert.match(run, /\n {12}--json-schema '\$\{\{ steps\.prepare\.outputs\.schema \}\}'\n/u);
  assert.match(run, /\n {12}--add-dir \$\{\{ steps\.prepare\.outputs\.inputs \}\}\n/u);
  assert.match(run, /\n {12}Post no comments; the workflow publishes your structured output\.\n/u);
  assert.match(run, /\n {10}allowed_bots: \$\{\{ inputs\.allowed_bots \}\}\n/u);
});

test('a hung review step fails before its job times out', () => {
  const jobs = jobsOf(reviewWorkflow());
  const run = stepText(jobs.claude, claudeStep);
  const step = Number(run.match(/\n {8}timeout-minutes: (\d+)\n/u)[1]);
  for (const name of reviewerJobs(jobs)) {
    const job = Number(jobs[name].match(/\n {4}timeout-minutes: (\d+)\n/u)[1]);
    assert.ok(step < job, `${name}: step ${step} must time out before job ${job}`);
  }
});

test('the verdict downloads the required review after Sonnet finishes', () => {
  const job = jobsOf(reviewWorkflow()).verdict;
  assert.match(
    job,
    /\n {4}if: always\(\) && \(contains\(needs\.\*\.result, 'success'\) \|\| contains\(needs\.\*\.result, 'failure'\)\)\n/u,
  );
  const steps = stepsOf(job);
  assert.equal(steps.match(/\n {6}- /gu).length, 2);
  assert.ok(steps.indexOf('actions/download-artifact@') < steps.indexOf(`- id: publish\n        uses: ${action}\n`));
  // An unavailable required artifact still needs a published verdict.
  const download = stepText(job, 'actions/download-artifact@');
  assert.match(download, /^actions\/download-artifact@[a-f0-9]{40} # v[\d.]+\n/u);
  const outputs = '${{ runner.temp }}/ai-review-outputs';
  for (const line of [
    'timeout-minutes: 2',
    'continue-on-error: true',
    '  name: ai-review-claude',
    `  path: ${outputs}`,
  ]) {
    assert.ok(download.includes(`\n        ${line}\n`) || download.endsWith(`\n        ${line}`), line);
  }
  const timeout = (text) => Number(text.match(/\n {4,8}timeout-minutes: (\d+)\n/u)[1]);
  assert.ok(timeout(download) < timeout(job));
  for (const line of [
    'step: publish',
    'reviews: ${{ toJSON(needs) }}',
    `review-outputs: ${outputs}`,
    'human-review-paths: ${{ inputs.human_review_paths }}',
  ]) {
    assert.ok(job.includes(`\n          ${line}\n`), line);
  }
});
