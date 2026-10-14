'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { statusContext, humanStatusContext, publish } = require('./ai-review.cjs');
const { reviewersOf } = require('./reviews.cjs');
const {
  sha,
  finding,
  reviewJson,
  needsOf,
  useReviews,
  clearAfter,
  client,
  context,
  core,
} = require('./test-helpers.cjs');
const { tempDir } = require('./test-git.cjs');

const job = (result, outputs) => ({ result, outputs });

// A directory of reviewer outputs, as the verdict job downloads them, from
// { job ID: structured output }.
function outputsDir(t, outputs) {
  const dir = tempDir(t, 'ai-review-outputs-');
  for (const [id, json] of Object.entries(outputs)) fs.writeFileSync(path.join(dir, `ai-review-${id}.json`), json);
  return dir;
}

test('every job in needs is a reviewer, named by its output or its job ID, in the order needs lists them', (t) => {
  const needs = {
    codex: job('failure', { reviewer: 'Codex', model: '', candidates: '' }),
    claude: job('success', { reviewer: ' Claude ', model: ' claude-opus-5-5 ', candidates: '["bob"]' }),
    // A skipped or early-cancelled job sets no outputs, but still counts.
    gemini: job('skipped', {}),
    mistral: { result: 'cancelled' },
    other: job('success', { reviewer: '  ' }),
  };
  const { reviewers, candidates } = reviewersOf(JSON.stringify(needs), outputsDir(t, { claude: 'x' }));
  // Only the job with a file has no reason it was not read.
  assert.deepEqual(
    reviewers.map((r) => /ENOENT/u.test(r.unread)),
    [true, false, true, true, true],
  );
  assert.deepEqual(
    { reviewers: reviewers.map(({ name, model, result, output }) => ({ name, model, result, output })), candidates },
    {
      reviewers: [
        { name: 'Codex', model: '', result: 'failure', output: '' },
        { name: 'Claude', model: 'claude-opus-5-5', result: 'success', output: 'x' },
        { name: 'Gemini', model: '', result: 'skipped', output: '' },
        { name: 'Mistral', model: '', result: 'cancelled', output: '' },
        { name: 'Other', model: '', result: 'success', output: '' },
      ],
      candidates: '["bob"]',
    },
  );
  for (const raw of [undefined, '', 'not json', 'null', '[]', '7', '{"a":null}']) {
    assert.deepEqual(reviewersOf(raw, outputsDir(t, { a: 'x' })), { reviewers: [], candidates: '' }, String(raw));
  }
});

test("each reviewer's output is its job's file, never a job output", (t) => {
  const dir = outputsDir(t, { claude: 'x' });
  // Unreadable, as a file.
  fs.mkdirSync(path.join(dir, 'ai-review-codex.json'));
  const needs = JSON.stringify({
    claude: job('success', { reviewer: 'Claude', findings: 'stale' }),
    codex: job('success', { reviewer: 'Codex', findings: 'y' }),
    gemini: job('success', { reviewer: 'Gemini', findings: 'z' }),
  });
  const outputs = (at) => reviewersOf(needs, at).reviewers.map((r) => r.output);
  assert.deepEqual(outputs(dir), ['x', '', '']);
  // A failed download leaves no directory.
  for (const at of [undefined, '', path.join(dir, 'missing')]) assert.deepEqual(outputs(at), ['', '', ''], String(at));
  assert.equal(reviewersOf(needs, '').reviewers[0].unread, 'no directory holds ai-review-claude.json');
  assert.match(reviewersOf(needs, dir).reviewers[1].unread, /EISDIR/u);
});

test("reviewer candidates come from the first reviewer that found any, as each job's output", () => {
  const candidates = (...lists) =>
    reviewersOf(needsOf(...lists.map((list, i) => [`R${i}`, 'success', '', list]))).candidates;
  assert.equal(candidates('["alice"]', '["bob"]'), '["alice"]');
  assert.equal(candidates('', '["bob"]'), '["bob"]');
  // An empty list is still the first reviewer's answer, as the base history is the same.
  assert.equal(candidates('[]', '["bob"]'), '[]');
  assert.equal(candidates('', ''), '');
});

test('publish keeps the reviewers in order, without naming them', async (t) => {
  clearAfter(t, 'REVIEWS', 'REVIEW_OUTPUTS');
  process.env.REVIEWS = JSON.stringify({
    second: job('success', { reviewer: 'Gemini' }),
    first: job('success', { reviewer: 'Claude' }),
  });
  process.env.REVIEW_OUTPUTS = outputsDir(t, {
    second: reviewJson({ summary: 'G.' }),
    first: reviewJson({ findings: [finding('p3')] }),
  });
  const c = client();
  await publish({ github: c.github, context: context(), core: core() });
  const [{ body }] = c.named('createComment');
  // The first reviewer's summary stands for the review.
  assert.match(body, /\n\nG\.\n\n\*\*⚪ P3\*\*\n- `internal\/a\.go:12` Nil map write\n/u);
  assert.match(body, /\*\*Not checked:\*\* The AI review read the diff/u);
  assert.doesNotMatch(body, /Gemini|Claude/u);
});

test('publish warns once for each review that did not complete', async (t) => {
  useReviews(t, ['Claude', 'failure'], ['Codex', 'success', reviewJson()], ['Gemini', 'cancelled', reviewJson()]);
  const c = client();
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  assert.deepEqual(k.failures, []);
  assert.deepEqual(k.warnings, [
    'The Claude review of abcdef1 did not complete, so the verdict rests on Codex.',
    'The Gemini review of abcdef1 did not complete, so the verdict rests on Codex.',
  ]);
  assert.deepEqual(c.set(statusContext), [
    [sha, 'success', 'No P0-P2 findings (0 P3, 0 pre-existing; 2 of 3 reviews did not complete).'],
  ]);
  assert.deepEqual(c.set(humanStatusContext), [[sha, 'success', 'No human review needed.']]);
});

test('a reviewer job that succeeded without a readable output did not complete', async (t) => {
  for (const json of ['', '{"summary":"Adds a cache.","findings":[', 'null']) {
    useReviews(t, ['Claude', 'success', json], ['Codex', 'success', reviewJson()]);
    const c = client();
    const k = core();
    await publish({ github: c.github, context: context(), core: k });
    assert.deepEqual(k.failures, [], json);
    // The run log says why the file was missing, which a bad download layout would cause.
    const unread = json ? [] : [/^Could not read the Claude review's output: ENOENT/u];
    assert.equal(k.warnings.length, unread.length + 1, json);
    unread.forEach((pattern, i) => assert.match(k.warnings[i], pattern, json));
    assert.equal(
      k.warnings.at(-1),
      'The Claude review of abcdef1 did not complete, so the verdict rests on Codex.',
      json,
    );
    assert.deepEqual(
      c.set(statusContext),
      [[sha, 'success', 'No P0-P2 findings (0 P3, 0 pre-existing; 1 of 2 reviews did not complete).']],
      json,
    );
  }
});

test('publish reads an output larger than an environment variable holds', async (t) => {
  const long = 'Explains the race. '.repeat(400);
  const findings = Array.from({ length: 30 }, (_, i) =>
    finding('p2', { line: i + 1, title: `Race ${i}`, detail: long }),
  );
  const json = reviewJson({ findings });
  assert.ok(Buffer.byteLength(json) > 128 * 1024);
  useReviews(t, ['Codex', 'success', json, '', 'gpt-6.1-sol']);
  const c = client();
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  assert.deepEqual(k.warnings, []);
  assert.deepEqual(c.set(statusContext), [[sha, 'failure', '30 P0-P2 finding(s). See the AI review comment.']]);
  const posted = c.named('createReviewComment');
  assert.equal(posted.length, 30);
  for (const { body } of posted) assert.ok(body.length < 1800, body.length);
});

test('publish with no reviewer, or none that completed, errors the verdict and fails the job', async (t) => {
  clearAfter(t, 'REVIEWS', 'REVIEW_OUTPUTS');
  const cases = [
    [undefined],
    ['{}'],
    [JSON.stringify({ start: job('success', { review: 'true' }) })],
    // A failed download leaves no outputs.
    [needsOf(['Claude', 'success'], ['Codex', 'success']), path.join(outputsDir(t, {}), 'missing')],
  ];
  for (const [raw, dir] of cases) {
    if (raw === undefined) delete process.env.REVIEWS;
    else process.env.REVIEWS = raw;
    if (dir === undefined) delete process.env.REVIEW_OUTPUTS;
    else process.env.REVIEW_OUTPUTS = dir;
    const c = client();
    const k = core();
    await publish({ github: c.github, context: context(), core: k });
    assert.deepEqual(
      c.set(statusContext).map(([, state]) => state),
      ['error'],
      String(raw),
    );
    assert.deepEqual(k.failures, [`No AI review produced a verdict for ${sha}.`], String(raw));
    assert.deepEqual(c.set(humanStatusContext), [[sha, 'pending', 'Needs human review: No AI review completed.']]);
  }
});
