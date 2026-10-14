'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, publish } = require('./ai-review.cjs');
const { reviewersOf } = require('./reviews.cjs');
const { sha, finding, reviewJson, needsOf, clearAfter, client, context, core } = require('./test-helpers.cjs');

const job = (result, outputs) => ({ result, outputs });

test('every job in needs is a reviewer, named by its output or its job ID, in the order needs lists them', () => {
  const needs = {
    codex: job('failure', { reviewer: 'Codex', findings: '', candidates: '' }),
    claude: job('success', { reviewer: ' Claude ', findings: 'x', candidates: '["bob"]' }),
    // A skipped or early-cancelled job sets no outputs, but still counts.
    gemini: job('skipped', {}),
    mistral: { result: 'cancelled' },
    other: job('success', { reviewer: '  ' }),
  };
  assert.deepEqual(reviewersOf(JSON.stringify(needs)), {
    reviewers: [
      { name: 'Codex', result: 'failure', output: '' },
      { name: 'Claude', result: 'success', output: 'x' },
      { name: 'Gemini', result: 'skipped', output: '' },
      { name: 'Mistral', result: 'cancelled', output: '' },
      { name: 'Other', result: 'success', output: '' },
    ],
    candidates: '["bob"]',
  });
  for (const raw of [undefined, '', 'not json', 'null', '[]', '7', '{"a":null}']) {
    assert.deepEqual(reviewersOf(raw), { reviewers: [], candidates: '' }, String(raw));
  }
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
  clearAfter(t, 'REVIEWS');
  process.env.REVIEWS = JSON.stringify({
    second: job('success', { reviewer: 'Gemini', findings: reviewJson({ summary: 'G.' }) }),
    first: job('success', { reviewer: 'Claude', findings: reviewJson({ findings: [finding('p3')] }) }),
  });
  const c = client();
  await publish({ github: c.github, context: context(), core: core() });
  const [{ body }] = c.named('createComment');
  // Without a merge, the first reviewer's summary stands for the review.
  assert.match(body, /\n\nG\.\n\n\*\*⚪ P3\*\*\n- `internal\/a\.go:12` Nil map write\n/u);
  assert.match(body, /\*\*Not checked:\*\* The AI review read the diff/u);
  assert.doesNotMatch(body, /Gemini|Claude/u);
});

test('publish warns once for each review that did not complete', async (t) => {
  clearAfter(t, 'REVIEWS');
  process.env.REVIEWS = needsOf(
    ['Claude', 'failure'],
    ['Codex', 'success', reviewJson()],
    ['Gemini', 'cancelled', reviewJson()],
  );
  const c = client();
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  assert.deepEqual(k.failures, []);
  assert.deepEqual(k.warnings, [
    'The Claude review of abcdef1 did not complete, so the verdict rests on Codex.',
    'The Gemini review of abcdef1 did not complete, so the verdict rests on Codex.',
  ]);
  assert.deepEqual(c.set(statusContext), [[sha, 'success', 'No P0-P2 findings (0 P3, 0 pre-existing).']]);
  assert.deepEqual(c.set(humanStatusContext), [[sha, 'success', 'No human review needed.']]);
});

test('publish with no reviewer, or none that completed, errors the verdict and fails the job', async (t) => {
  clearAfter(t, 'REVIEWS');
  for (const raw of [undefined, '{}', JSON.stringify({ start: job('success', { review: 'true' }) })]) {
    if (raw === undefined) delete process.env.REVIEWS;
    else process.env.REVIEWS = raw;
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
