'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, verdict, publish } = require('./ai-review.cjs');
const { sha, url, finding, routine, reviewJson, useReviews, client, context, core } = require('./test-helpers.cjs');

// The verdict from a Claude and a Codex review, each given as its findings and
// human-review decision.
const both = (claude, codex, human = routine) =>
  verdict(
    [
      { name: 'Claude', result: 'success', output: reviewJson({ findings: claude, human }) },
      { name: 'Codex', result: 'success', output: reviewJson({ findings: codex, human }) },
    ],
    sha,
    url,
  );
const deferred = (severity, overrides = {}) =>
  finding(severity, { title: 'Move orchestration into a domain service', deferred: true, ...overrides });
const question = 'Can the deferred P2 finding(s) in the summary wait for the follow-up the author named?';

test('a P2 the author deferred goes to a person instead of failing the verdict', () => {
  const v = both([deferred('p2'), finding('p3', { line: 90, title: 'Stale comment' })], [deferred('p2', { line: 14 })]);
  assert.equal(v.state, 'success');
  assert.equal(v.description, '1 deferred P2 finding(s) for a person (1 P3, 0 pre-existing).');
  assert.ok(v.body.includes('\n### AI review: 1 deferred P2 finding(s)\n'));
  assert.ok(
    v.body.includes(
      '\n**⏸️ Deferred P2, for a person to decide**\n- `internal/a.go:12,14` Move orchestration into a domain service\n',
    ),
  );
  assert.doesNotMatch(v.body, /\*\*🟡 P2\*\*|ai-review-override/u);
  // A person decides, and nobody is told the code needs no second look.
  assert.deepEqual(v.reasons, [question]);
  assert.equal(v.cleared, false);
  const asked = both([deferred('p2')], [], { needed: true, reasons: ['Should the queue be shared?'] });
  assert.deepEqual(asked.reasons, [question, 'Should the queue be shared?']);
  assert.equal(asked.cleared, false);
});

test('only a P2 every reviewer deferred stops failing', () => {
  for (const [why, claude, codex] of [
    ['a deferred P1', [deferred('p1')], []],
    ['a deferred P0', [deferred('p0')], []],
    ['another reviewer still reports it', [deferred('p2')], [finding('p2', { title: 'Move orchestration out' })]],
    ['another reviewer ranks it P1', [deferred('p2')], [deferred('p1', { line: 13 })]],
  ]) {
    const v = both(claude, codex);
    assert.equal(v.state, 'failure', why);
    assert.equal(v.description, '1 P0-P2 finding(s). See the AI review comment.', why);
    assert.doesNotMatch(v.body, /Deferred P2/u, why);
    assert.deepEqual(v.reasons, [], why);
  }
});

test('a failing verdict lists deferred findings apart from the ones that fail it', () => {
  const v = both([deferred('p2'), finding('p1', { path: 'internal/b.go', title: 'Unchecked error' })], []);
  assert.equal(v.state, 'failure');
  assert.equal(v.description, '1 P0-P2 finding(s). See the AI review comment.');
  assert.match(
    v.body,
    /\*\*🟠 P1\*\*\n- `internal\/b\.go:12` Unchecked error\n\n\*\*⏸️ Deferred P2, for a person to decide\*\*\n/u,
  );
  assert.deepEqual(v.reasons, [question]);
});

test('a deferred P2 gets no inline comment; any other finding still does', async (t) => {
  useReviews(t, [
    'Claude',
    'success',
    reviewJson({ findings: [deferred('p2'), deferred('p1', { line: 30, title: 'Unchecked error' })] }),
    '',
    'claude-opus-5-5',
  ]);
  const c = client();
  await publish({ github: c.github, context: context(), core: core() });
  assert.deepEqual(
    c.named('createReviewComment').map(({ line, body }) => [line, body.split('\n')[0]]),
    [[30, '**🟠 P1:** Unchecked error']],
  );
  assert.equal(c.set(statusContext)[0][1], 'failure');
});
