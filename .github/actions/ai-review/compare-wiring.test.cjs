'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { action, jobsOf, reviewWorkflow, stepText, pinnedCheckout } = require('./test-workflow.cjs');
const { finding, reviewJson } = require('./test-helpers.cjs');
const { tempDir } = require('./test-git.cjs');

test('the advisory comparison reads only the pinned action and the two review artifacts', () => {
  const { compare, verdict, cost } = jobsOf(reviewWorkflow());
  assert.match(compare, /\n {4}needs: \[claude, opus\]\n/u);
  assert.match(compare, /\n {4}if: needs\.claude\.result == 'success' && needs\.opus\.result == 'success'\n/u);
  assert.match(compare, /\n {4}continue-on-error: true\n {4}permissions:\n {6}contents: read\n {4}steps:/u);
  assert.doesNotMatch(compare, /: write|secrets\./u);
  const checkout = stepText(compare, 'actions/checkout@');
  assert.ok(checkout.includes(`\n          ref: ${action.split('@')[1]}\n`));
  assert.match(checkout, /\n {10}repository: Kong\/volcano-actions\n/u);
  assert.match(checkout, /\n {10}persist-credentials: false(?:\n|$)/u);
  const download = stepText(compare, 'actions/download-artifact@');
  assert.match(download, /\n {10}pattern: ai-review-\{claude,opus\}\n {10}merge-multiple: true\n/u);
  assert.doesNotMatch(verdict + cost, /\n {4}needs: [^\n]*compare/u);
});

async function comparison(t, { sonnet, opus, opusDigest = 'same input files' }) {
  const checkout = pinnedCheckout(t);
  const dir = tempDir(t, 'ai-review-compare-');
  const entries = {};
  for (const [job, model, findings, digest] of [
    ['claude', 'claude-sonnet-5-5', sonnet, 'same input files'],
    ['opus', 'claude-opus-5-5', opus, opusDigest],
  ]) {
    entries[job] = { result: 'success', outputs: { model } };
    if (findings) fs.writeFileSync(path.join(dir, `ai-review-${job}.json`), reviewJson({ findings }));
    if (digest) fs.writeFileSync(path.join(dir, `ai-review-${job}.inputs.sha256`), digest);
  }
  const step = stepText(jobsOf(reviewWorkflow()).compare, '- name: Flag Opus-only findings');
  const script = step.split('\n          script: |\n')[1].replaceAll(/^ {12}/gmu, '');
  const text = [];
  const summary = {
    addHeading(heading) {
      text.push(heading);
      return this;
    },
    addRaw(line) {
      text.push(line);
      return this;
    },
    addCodeBlock(block) {
      text.push(block);
      return this;
    },
    async write() {},
  };
  const env = { GITHUB_WORKSPACE: checkout, REVIEW_OUTPUTS: dir, REVIEWS: JSON.stringify(entries) };
  await vm.runInNewContext(`(async () => {\n${script}\n})()`, { require, process: { env }, core: { summary } });
  return text.join('\n');
}

test('the comparison flags unique Opus findings and shows the counterfactual verdict', async (t) => {
  const sonnet = [finding('p3', { title: 'Wrong cache key' })];
  const opus = [
    finding('p2', { title: 'Lookup uses a stale key', line: 14 }),
    finding('p1', { title: 'Missed <bug> | in render', path: 'internal/render.go', line: 31 }),
    finding('p2', { title: 'Follow-up', path: 'internal/setup.go', deferred: true }),
  ];
  const report = await comparison(t, { sonnet, opus });
  assert.match(report, /Sonnet alone \*\*pass\*\*, combined \*\*fail\*\*/u);
  assert.match(report, /2 candidate\(s\) reported only by Opus\. Of those, 1 block/u);
  assert.match(report, /P1 \| internal\/render\.go:31 \| Missed &lt;bug&gt; \| in render/u);
  assert.match(report, /Deferred P2 \| internal\/setup\.go:12 \| Follow-up/u);
  assert.doesNotMatch(report, /Wrong cache key|Lookup uses a stale key/u);
});

test('an unmatched or incomplete pair never produces candidate findings', async (t) => {
  const sonnet = [];
  const opus = [finding('p1')];
  for (const input of [
    { sonnet, opus, opusDigest: 'the PR description changed' },
    { sonnet, opus, opusDigest: '' },
    { sonnet, opus: undefined },
  ]) {
    const report = await comparison(t, input);
    assert.match(report, /Comparison unavailable\./u);
    assert.doesNotMatch(report, /candidate\(s\)|combined \*\*fail/u);
  }
});
