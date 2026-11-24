'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { reviewWorkflow, action, jobsOf, stepsOf, reviewerJobs, modelOf } = require('./test-workflow.cjs');
const { tempDir } = require('./test-git.cjs');

// A public repository's artifacts are public, so usage is recorded there only
// for a collector.
const recorded = "always() && (github.event.repository.private || inputs.otlp_endpoint != '')";

test('the shared steps record usage by job and model without failing the review', () => {
  const steps = stepsOf(jobsOf(reviewWorkflow()).claude);
  const usage = steps.slice(steps.indexOf('step: usage') - 200);
  const file = '${{ runner.temp }}/ai-review-usage-${{ github.job }}.json';
  assert.ok(
    steps.includes(
      `- if: ${recorded}\n        uses: ${action}\n        continue-on-error: true\n        with:\n          step: usage\n          provider: claude\n`,
    ),
  );
  assert.ok(usage.includes(`\n          usage-file: ${file}\n`));
  assert.ok(usage.includes('\n          model: ${{ env.REVIEW_MODEL }}\n'));
  const upload = steps.slice(steps.lastIndexOf('actions/upload-artifact@'));
  assert.ok(steps.lastIndexOf(`- if: ${recorded}\n        uses: actions/upload-artifact@`) !== -1);
  assert.ok(upload.includes(`\n          name: ai-review-usage-\${{ github.job }}\n          path: ${file}\n`));
  assert.match(upload, /\n {10}retention-days: 1\n/u);
});

test('the cost job runs after the verdict, even when the run was cancelled, and holds no more than it needs', () => {
  const workflow = reviewWorkflow();
  const jobs = jobsOf(workflow);
  const { cost } = jobs;
  // It prices only the reviewers it needs, so it needs every one.
  assert.deepEqual(cost.match(/\n {4}needs: \[(.*)\]\n/u)[1].split(', '), [...reviewerJobs(jobs), 'verdict']);
  assert.ok(cost.includes(`\n      ${recorded.replace(' && (', ' &&\n      (')} &&\n`));
  assert.match(cost, /contains\(needs\.\*\.result, 'cancelled'\)/u);
  assert.match(cost, /\n {4}permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}pull-requests: write\n {4}steps:/u);
  assert.match(cost, /\n {10}pattern: ai-review-usage-\*\n {10}merge-multiple: true\n/u);
  assert.ok(
    cost.includes(
      `uses: ${action}\n        with:\n          step: cost\n          reviews: \${{ toJSON(needs) }}\n          usage-outputs: \${{ runner.temp }}/ai-review-usage\n          otlp-endpoint: \${{ inputs.otlp_endpoint }}\n          otlp-headers: \${{ secrets.otlp_headers }}\n`,
    ),
  );
  // The collector's headers are a secret, its endpoint an input.
  assert.match(workflow, /\n {6}otlp_endpoint:\n(?: {8}.*\n)*? {8}type: string\n {8}default: ''\n/u);
  assert.match(workflow, /\n {6}otlp_headers:\n(?: {8}.*\n)*? {8}required: false\n/u);
});

// The cost job hands the pinned action each reviewer job's usage file.
test('the pinned action prices the usage file each reviewer job uploads', (t) => {
  const at = tempDir(t, 'ai-review-pinned-cost-');
  const { execFileSync } = require('node:child_process');
  const { root } = require('./test-helpers.cjs');
  const archive = path.join(at, 'pinned.tar');
  execFileSync('git', ['archive', '-o', archive, action.split('@')[1], '.github/actions/ai-review'], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', at]);
  const { runSpend } = require(path.join(at, '.github/actions/ai-review/spend.cjs'));
  const jobs = jobsOf(reviewWorkflow());
  const dir = tempDir(t, 'ai-review-usage-');
  const needs = { verdict: { result: 'success', outputs: {} } };
  for (const name of reviewerJobs(jobs)) {
    const model = modelOf(jobs[name]);
    const usage = {
      provider: 'claude',
      attempt: 1,
      models: { [model]: { calls: 1, tokens: { input: 1000, output: 100 } } },
    };
    fs.writeFileSync(path.join(dir, `ai-review-usage-${name}.json`), JSON.stringify(usage));
    needs[name] = { result: 'success', outputs: { reviewer: name, model } };
  }
  const spend = runSpend(JSON.stringify(needs), dir, false, 1);
  assert.deepEqual(
    spend.map((r) => [r.job, r.known, r.cost > 0]),
    reviewerJobs(jobs).map((name) => [name, true, true]),
  );
});
