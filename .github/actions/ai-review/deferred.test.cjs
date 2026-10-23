'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, verdict, publish, gate } = require('./ai-review.cjs');
const { marker } = require('./constants.cjs');
const { decisionMarker } = require('./decision.cjs');
const {
  sha,
  url,
  finding,
  routine,
  reviewJson,
  useReviews,
  review,
  client,
  context,
  core,
} = require('./test-helpers.cjs');

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
const question =
  'Can the P2 finding(s) the author deferred or declined, listed in the summary, stand as the author answered?';

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

// An approval carries across pushes, but one given before the author deferred
// a finding cannot have decided it, even of the same commit.
test('a deferred finding needs an approval of the reviewed commit given since', async (t) => {
  useReviews(t, ['Claude', 'success', reviewJson({ findings: [deferred('p2')] }), '', 'claude-opus-5-5']);
  const approved = (commit, at) => ({ ...review('reviewer', 'APPROVED', 'User', commit), submitted_at: at });
  const human = async (reviews, comments = []) => {
    const c = client({ reviews, comments });
    await publish({ github: c.github, context: context(), core: core() });
    return { c, state: c.set(humanStatusContext).at(-1)[1] };
  };
  const later = '2999-01-01T00:00:00Z';
  const earlier = await human([approved('fedcba9876543210', later)]);
  assert.equal(earlier.state, 'pending');
  assert.equal((await human([approved(sha, '2001-01-01T00:00:00Z')])).state, 'pending');
  assert.equal((await human([approved(sha, later)])).state, 'success');
  // The verdict passes once the summary records the deferral.
  assert.deepEqual(
    earlier.c.set(statusContext).map(([, state]) => state),
    ['failure', 'success'],
  );
  const [{ body }] = earlier.c.named('createComment');
  assert.match(body, /approve abcdef1 now to accept them/u);

  // A re-run keeps the time the deferral was first reported.
  const since = JSON.parse(Buffer.from(body.match(/<!-- ai-review-human (\S+) -->$/u)[1], 'base64')).since;
  const rerun = await human([approved(sha, since)], [{ id: 2, user: { login: 'github-actions[bot]' }, body }]);
  assert.equal(rerun.state, 'success');

  // The human gate reads the same rule back from the summary comment.
  const gated = client({
    comments: [{ id: 2, user: { login: 'github-actions[bot]' }, body }],
    reviews: [approved(sha, '2001-01-01T00:00:00Z')],
  });
  await gate({ github: gated.github, context: context({ action: 'labeled' }), core: core() });
  assert.equal(gated.set(humanStatusContext).at(-1)[1], 'pending');
});

// A re-run of a commit keeps the time of its deferral only when it defers
// nothing new, by title and location; otherwise an approval given before it
// asks that person again.
test('a re-run that defers another problem needs a new approval', async (t) => {
  const title = 'Move orchestration into a domain service';
  const stored = [`${title} @ internal/a.go:12`];
  const summary = (deferredProblems) => ({
    id: 2,
    user: { login: 'github-actions[bot]' },
    body: `${marker}\n### AI review\n\n${decisionMarker(sha, { reasons: [question], reviewer: null, since: '2001-01-01T00:00:00Z', deferred: deferredProblems })}`,
  });
  const rerun = async (findings, deferredProblems) => {
    useReviews(t, ['Claude', 'success', reviewJson({ findings }), '', 'claude-opus-5-5']);
    const c = client({
      reviews: [{ ...review('reviewer', 'APPROVED'), submitted_at: '2002-01-01T00:00:00Z' }],
      comments: [summary(deferredProblems)],
    });
    await publish({ github: c.github, context: context(), core: core() });
    const [{ body }] = c.named('updateComment');
    const { since } = JSON.parse(Buffer.from(body.match(/<!-- ai-review-human (\S+) -->$/u)[1], 'base64'));
    return {
      state: c.set(humanStatusContext).at(-1)[1],
      since,
      asked: c.named('requestReviewers').map((r) => r.reviewers),
    };
  };
  const same = await rerun([deferred('p2')], stored);
  assert.deepEqual(same, { state: 'success', since: '2001-01-01T00:00:00Z', asked: [] });
  for (const [why, findings, before] of [
    ['another problem', [deferred('p2'), deferred('p2', { path: 'internal/b.go', title: 'Unchecked error' })], stored],
    ['a second problem under the same title', [deferred('p2'), deferred('p2', { path: 'internal/c.go' })], stored],
    ['the problem elsewhere', [deferred('p2', { line: 40 })], stored],
    ['a summary that names none', [deferred('p2')], []],
  ]) {
    const added = await rerun(findings, before);
    assert.equal(added.state, 'pending', why);
    assert.ok(Date.parse(added.since) > Date.parse('2002-01-01T00:00:00Z'), why);
    // The approver whose approval no longer counts is asked again.
    assert.deepEqual(added.asked, [['reviewer']], why);
  }
});

// The human gate reads the deferral back from the summary, so a deferral the
// summary does not record keeps the verdict failing.
test('a deferred finding fails the verdict when the summary cannot record it', async (t) => {
  useReviews(t, ['Claude', 'success', reviewJson({ findings: [deferred('p2')] }), '', 'claude-opus-5-5']);
  for (const options of [{ failComments: true }, { liveHead: 'fedcba9876543210' }]) {
    const c = client(options);
    await publish({ github: c.github, context: context(), core: core() });
    assert.deepEqual(
      c.set(statusContext).map(([, state, description]) => [state, description]),
      [['failure', 'The summary does not record the deferred finding(s) yet. If this stays, re-run the review.']],
      JSON.stringify(options),
    );
  }
});

// The deferral dates from just before the summary reports it, and the human
// status follows the summary, so nobody approves before they could read it.
test('the human status is set after the summary reports a deferral', async (t) => {
  useReviews(t, ['Claude', 'success', reviewJson({ findings: [deferred('p2')] }), '', 'claude-opus-5-5']);
  const c = client();
  await publish({ github: c.github, context: context(), core: core() });
  const order = c.calls
    .filter((call) => call.call === 'createComment' || call.context === humanStatusContext)
    .map((call) => call.call);
  assert.deepEqual(order, ['createComment', 'createCommitStatus']);
});
