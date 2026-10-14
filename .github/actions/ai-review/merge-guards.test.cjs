'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verdict } = require('./ai-review.cjs');
const { mergeReviews } = require('./merge.cjs');
const { sha, url, finding, reviewJson, core } = require('./test-helpers.cjs');
const { anthropicKey, setKeys, mergedReview, fromAnthropic, fakeFetch } = require('./test-models.cjs');

const asks = (reasons) => ({ needed: true, reasons, reviewer: '', reviewer_reason: '' });
const nilMap = finding('p1');
const nilMapReworded = finding('p1', { title: 'Writes to a nil map' });
const typo = finding('p3', { title: 'Typo' });
// Two reviews whose findings, without repeats, are [nilMap, typo, nilMapReworded].
const outputs = [
  reviewJson({ findings: [nilMap, typo] }),
  reviewJson({ summary: 'Caches lookups.', findings: [nilMapReworded] }),
];
const reviewers = (raw) => raw.map((output, i) => ({ name: `R${i}`, result: 'success', output }));

// Merges the reviews with a model that answers `answer`, and returns the
// merge, the verdict that shows it, and the run log's warnings.
async function mergeWith(t, answer, raw = outputs) {
  setKeys(t, { anthropic: anthropicKey });
  t.mock.restoreAll();
  fakeFetch(t, fromAnthropic(answer));
  const k = core();
  const merged = await mergeReviews(
    raw.map((o) => JSON.parse(o)),
    k,
    { timeout: 50, retryDelay: 0 },
  );
  return { merged, v: verdict(reviewers(raw), sha, url, [], merged), warnings: k.warnings };
}

test("a merge that weakens or invents findings shows the reviews' own instead", async (t) => {
  const dropped = [typo];
  const lowered = [finding('p2', { title: 'Writes to a nil map' }), typo];
  const added = [nilMap, typo, nilMapReworded, finding('p3', { title: 'Invented' })];
  const unknown = [finding('p9'), typo];
  for (const [why, findings] of [
    ['dropped every P0-P2 finding', dropped],
    ['lowered the highest severity', lowered],
    ['added findings', added],
    ['gave a finding an unknown severity', unknown],
  ]) {
    const { merged, v, warnings } = await mergeWith(t, mergedReview({ findings }));
    assert.deepEqual(
      merged.findings.map((f) => f.title),
      ['Nil map write', 'Typo', 'Writes to a nil map'],
      why,
    );
    assert.equal(merged.summary, 'Adds a cache for lookups.', why);
    assert.deepEqual(warnings, [`The Anthropic merge ${why}, so the comment lists the reviews' own findings.`]);
    assert.equal(v.state, 'failure', why);
    assert.equal(v.description, '2 P0-P2 finding(s). See the AI review comment.', why);
    assert.match(
      v.body,
      /### AI review: 2 P0-P2 finding\(s\)\n\nReviewed abcdef1\. .*\n\nAdds a cache for lookups\.\n/u,
    );
  }
});

test('a merge cannot raise a passing review to P0-P2', async (t) => {
  const raw = [reviewJson({ findings: [typo] }), reviewJson({ findings: [typo] })];
  const { merged, v, warnings } = await mergeWith(t, mergedReview({ findings: [finding('p1')] }), raw);
  assert.deepEqual(merged.findings, [{ ...typo }]);
  assert.match(warnings[0], /raised a finding to P0-P2/u);
  assert.equal(v.state, 'success');
  assert.equal(v.description, 'No P0-P2 findings (1 P3, 0 pre-existing).');
});

test('a sound merge shows its own findings, normalized, and keeps the verdict the reviews reached', async (t) => {
  const findings = [finding('P1', { title: 'Writes to a nil map' }), typo];
  const { merged, v, warnings } = await mergeWith(t, mergedReview({ findings }));
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    merged.findings.map((f) => [f.severity, f.title]),
    [
      ['p1', 'Writes to a nil map'],
      ['p3', 'Typo'],
    ],
  );
  assert.equal(v.state, 'failure');
  assert.equal(v.description, '1 P0-P2 finding(s). See the AI review comment.');
  assert.match(v.body, /\*\*🟠 P1\*\*\n- `internal\/a\.go:12` Writes to a nil map\n\n\*\*⚪ P3\*\*\n- .* Typo\n/u);
  assert.deepEqual([v.cleared, v.reasons], [undefined, []]);
});

test('the merge words the reasons only when the reviews need a person, and never decides that', async (t) => {
  const asking = [reviewJson({ human: asks(['Changes billing?']) }), reviewJson({ human: asks(['Billing?']) })];
  const worded = await mergeWith(t, mergedReview({ reasons: ['Should billing round down?'] }), asking);
  assert.deepEqual(worded.v.reasons, ['Should billing round down?']);
  const silent = await mergeWith(t, mergedReview({ reasons: [] }), asking);
  assert.deepEqual(silent.v.reasons, ['Changes billing?', 'Billing?']);
  // The reviews need no person, so the merge's reasons cannot ask for one.
  const routine = [reviewJson(), reviewJson()];
  const ignored = await mergeWith(t, mergedReview({ reasons: ['Should billing round down?'] }), routine);
  assert.deepEqual(ignored.v.reasons, []);
});

test('merged text is capped at the schema lengths and cannot ping people', async (t) => {
  const { v } = await mergeWith(
    t,
    mergedReview({
      summary: `Hi @kong/everyone ${'s'.repeat(1600)}`,
      findings: [nilMap, typo, finding('p1', { title: `cc @someone ${'t'.repeat(300)}`, path: 'p'.repeat(400) })],
      reasons: Array.from({ length: 7 }, (_, i) => `${i}${'r'.repeat(300)}`),
      notChecked: ['Load.', 'Load.', 'n'.repeat(300)],
    }),
    [reviewJson({ findings: [nilMap, typo], human: asks(['x']) }), reviewJson({ findings: [nilMapReworded] })],
  );
  assert.ok(v.body.includes(`\n\nHi @​kong/everyone ${'s'.repeat(1499 - 18)}…\n`));
  assert.ok(v.body.includes(`\n- \`${'p'.repeat(299)}…:12\` cc @​someone ${'t'.repeat(199 - 12)}…\n`));
  assert.ok(v.body.includes(`\n- Load.\n- ${'n'.repeat(199)}…\n\nPush a fix`));
  assert.equal(v.reasons.length, 5);
  for (const reason of v.reasons) assert.equal([...reason].length, 200);
});
