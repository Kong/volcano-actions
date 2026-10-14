'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, publish } = require('./ai-review.cjs');
const { sha, finding, reviewJson, needsOf, clearAfter, client, context, core } = require('./test-helpers.cjs');

const why = 'The first `Put` writes to a nil `seen` map and panics. Make the map in `New`.';
const nilMap = finding('p1', { detail: why });
const typo = finding('p3', { path: 'docs/a.md', line: 3, title: 'Typo @kong/docs' });
const fileLevel = finding('pre_existing', { line: 0, title: 'Old debt' });
const opus = `**🟠 P1:** Nil map write\n\n${why}\n\n<sub>Found by claude-opus-5-5</sub>`;

// Publishes these reviewers, as [name, result, findings, candidates, model].
async function publishWith(reviewers, options = {}) {
  process.env.REVIEWS = needsOf(...reviewers);
  const c = client(options);
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  const posted = c.named('createReviewComment').map(({ path, line, body }) => [path, line, body]);
  return { c, k, posted };
}

test("publish posts each completed review's findings on a line, signed by its model", async (t) => {
  clearAfter(t, 'REVIEWS');
  const { c, k, posted } = await publishWith([
    ['Claude', 'success', reviewJson({ findings: [nilMap, fileLevel, typo] }), '', 'claude-opus-5-5'],
    // Without a model, the reviewer's name signs its comments.
    ['Codex', 'success', reviewJson({ findings: [nilMap] })],
    ['Gemini', 'failure', reviewJson({ findings: [finding('p0')] }), '', 'gemini-3'],
  ]);
  assert.deepEqual(posted, [
    ['internal/a.go', 12, opus],
    ['docs/a.md', 3, '**⚪ P3:** Typo @​kong/docs\n\n<sub>Found by claude-opus-5-5</sub>'],
    ['internal/a.go', 12, `**🟠 P1:** Nil map write\n\n${why}\n\n<sub>Found by Codex</sub>`],
  ]);
  for (const comment of c.named('createReviewComment')) {
    assert.deepEqual([comment.pull_number, comment.commit_id, comment.side], [7, sha, 'RIGHT']);
  }
  // The status and summary go first, so comments cannot delay or block them.
  const order = c.calls.map((call) => call.call);
  assert.ok(order.indexOf('createComment') < order.indexOf('listReviewComments'));
  // The summary lists a problem two reviewers found once; each still comments.
  assert.deepEqual(c.set(statusContext)[0].slice(1), [
    'failure',
    '1 P0-P2 finding(s); 1 of 3 reviews did not complete. See the AI review comment.',
  ]);
  assert.deepEqual(
    [k.failures, k.warnings],
    [[], ['The Gemini review of abcdef1 did not complete, so the verdict rests on Claude and Codex.']],
  );
});

test('every level reads as the reviewers label it, and long text is capped', async (t) => {
  clearAfter(t, 'REVIEWS');
  const levels = ['p0', 'p1', 'p2', 'p3', 'pre_existing'].map((s, i) => finding(s, { line: i + 1, title: 'x' }));
  const { posted } = await publishWith([
    [
      'Claude',
      'success',
      reviewJson({ findings: [...levels, finding('p3', { title: 't'.repeat(201) })] }),
      '',
      'm'.repeat(101),
    ],
  ]);
  assert.deepEqual(
    posted.map(([, , body]) => body.split('\n')[0]),
    [
      '**🔴 P0:** x',
      '**🟠 P1:** x',
      '**🟡 P2:** x',
      '**⚪ P3:** x',
      '**🟣 Pre-existing:** x',
      `**⚪ P3:** ${'t'.repeat(199)}…`,
    ],
  );
  assert.ok(posted[0][2].endsWith(`<sub>Found by ${'m'.repeat(99)}…</sub>`));
});

const bot = { login: 'github-actions[bot]' };

test("publish skips a line where it already posted the model's finding at that level, whatever its wording", async (t) => {
  clearAfter(t, 'REVIEWS');
  const { c, posted } = await publishWith(
    [['Claude', 'success', reviewJson({ findings: [nilMap, nilMap, typo, fileLevel] }), '', 'claude-opus-5-5']],
    {
      reviewComments: [
        // The same model and level at the same line, worded differently and without a detail on an earlier run.
        {
          user: bot,
          path: 'internal/a.go',
          line: 12,
          body: '**🟠 P1:** A nil map write panics\n\n<sub>Found by claude-opus-5-5</sub>',
        },
        // The same model at another line, and another model at the same line.
        {
          user: bot,
          path: 'docs/a.md',
          line: 4,
          body: '**⚪ P3:** Typo @\u200Bkong/docs\n\n<sub>Found by claude-opus-5-5</sub>',
        },
        { user: bot, path: 'docs/a.md', line: 3, body: '**⚪ P3:** Typo\n\n<sub>Found by gpt-6.1-sol</sub>' },
      ],
    },
  );
  assert.deepEqual(
    posted.map(([path, line]) => [path, line]),
    [['docs/a.md', 3]],
  );
  assert.equal(c.named('listReviewComments').length, 1);
});

test("a detail, or its absence, never changes which of the model's earlier comments covers a finding", async (t) => {
  clearAfter(t, 'REVIEWS');
  const earlier = (detail) => ({
    user: bot,
    path: 'internal/a.go',
    line: 12,
    body: `**🟠 P1:** Nil map write${detail}\n\n<sub>Found by claude-opus-5-5</sub>`,
  });
  for (const [now, before] of [
    [finding('p1'), earlier(`\n\n${why}`)],
    [nilMap, earlier('\n\nAn earlier detail.\n\nIn two paragraphs.')],
  ]) {
    const { posted } = await publishWith(
      [['Claude', 'success', reviewJson({ findings: [now] }), '', 'claude-opus-5-5']],
      { reviewComments: [before] },
    );
    assert.deepEqual(posted, []);
  }
});

test('comments by anyone else, or at another level, never suppress a finding', async (t) => {
  clearAfter(t, 'REVIEWS');
  const link = finding('p1', { path: 'docs/a.md', line: 3, title: 'Broken link' });
  const { posted } = await publishWith(
    [['Claude', 'success', reviewJson({ findings: [nilMap, link] }), '', 'claude-opus-5-5']],
    {
      reviewComments: [
        // A forged footer from someone other than the action.
        { user: { login: 'mallory' }, path: 'internal/a.go', line: 12, body: opus },
        // The model's earlier P3 at the line does not cover a new P1 there.
        { user: bot, path: 'docs/a.md', line: 3, body: '**⚪ P3:** Typo\n\n<sub>Found by claude-opus-5-5</sub>' },
      ],
    },
  );
  assert.deepEqual(posted, [
    ['internal/a.go', 12, opus],
    ['docs/a.md', 3, '**🟠 P1:** Broken link\n\n<sub>Found by claude-opus-5-5</sub>'],
  ]);
});

test("a model's distinct findings on one line all post, and exact repeats post once", async (t) => {
  clearAfter(t, 'REVIEWS');
  const unchecked = finding('p1', { title: 'Unchecked error' });
  const { posted } = await publishWith([
    ['Claude', 'success', reviewJson({ findings: [nilMap, unchecked, nilMap] }), '', 'claude-opus-5-5'],
  ]);
  assert.deepEqual(posted, [
    ['internal/a.go', 12, opus],
    ['internal/a.go', 12, '**🟠 P1:** Unchecked error\n\n<sub>Found by claude-opus-5-5</sub>'],
  ]);
});

test('a comment outside the diff is skipped with a notice, and other errors only warn', async (t) => {
  clearAfter(t, 'REVIEWS');
  const reviewers = [['Claude', 'success', reviewJson({ findings: [nilMap, typo] }), '', 'claude-opus-5-5']];
  const outside = await publishWith(reviewers, {
    rejectComment: (args) => args.path === 'internal/a.go' && ['Validation Failed', 422],
  });
  assert.equal(outside.posted.length, 2);
  assert.deepEqual(
    outside.k.notices.filter((n) => n.startsWith('Skipped')),
    ['Skipped the comment on internal/a.go:12, which is outside the diff.'],
  );
  const broken = await publishWith(reviewers, { rejectComment: () => ['Server Error', 500] });
  assert.equal(broken.posted.length, 2);
  assert.deepEqual(broken.k.warnings, [
    'Could not comment on internal/a.go:12: Server Error',
    'Could not comment on docs/a.md:3: Server Error',
  ]);
  const unlisted = await publishWith(reviewers, { failReviewComments: true });
  assert.deepEqual(unlisted.posted, []);
  assert.match(unlisted.k.warnings[0], /^Could not read the PR's head or review comments, so none were posted/u);
  for (const { c, k } of [outside, broken, unlisted]) {
    assert.deepEqual(k.failures, []);
    assert.equal(c.set(statusContext)[0][1], 'failure');
    assert.equal(c.named('createComment').length, 1);
  }
});

test('nothing is posted without a completed finding on a line', async (t) => {
  clearAfter(t, 'REVIEWS');
  for (const reviewers of [
    [['Claude', 'success', reviewJson({ findings: [fileLevel] }), '', 'claude-opus-5-5']],
    [['Claude', 'failure', reviewJson({ findings: [nilMap] }), '', 'claude-opus-5-5']],
    [['Claude', 'success', reviewJson({ findings: [nilMap, finding('nit')] }), '', 'claude-opus-5-5']],
    [['Claude', 'success', reviewJson({ findings: [finding('p1', { line: '12' })] })]],
  ]) {
    const { c } = await publishWith(reviewers);
    assert.deepEqual(c.named('listReviewComments'), [], JSON.stringify(reviewers));
    assert.deepEqual(c.named('createReviewComment'), [], JSON.stringify(reviewers));
  }
});

test("a finding's detail sits between its title and footer, cleaned and capped", async (t) => {
  clearAfter(t, 'REVIEWS');
  const details = ['  Pings @kong/docs.\n', 'd'.repeat(1501), '🔥'.repeat(1500)];
  const findings = details.map((detail, i) => finding('p3', { line: i + 1, detail }));
  const { c, posted } = await publishWith([['Claude', 'success', reviewJson({ findings }), '', 'm']]);
  assert.deepEqual(
    posted.map(([, , body]) => body.split('\n\n')),
    ['Pings @\u200Bkong/docs.', `${'d'.repeat(1499)}…`, '🔥'.repeat(1500)].map((d) => [
      '**⚪ P3:** Nil map write',
      d,
      '<sub>Found by m</sub>',
    ]),
  );
  // The summary lists titles only.
  assert.doesNotMatch(c.named('createComment')[0].body, /Pings|ddd|🔥/u);
});

test('a finding without a detail completes, and its comment has only the title and footer', async (t) => {
  clearAfter(t, 'REVIEWS');
  const findings = [undefined, '', ' \n ', 42, null].map((detail, i) => finding('p1', { line: i + 1, detail }));
  const { c, k, posted } = await publishWith([['Claude', 'success', reviewJson({ findings }), '', 'm']]);
  assert.deepEqual(
    posted.map(([, line, body]) => [line, body]),
    [1, 2, 3, 4, 5].map((line) => [line, '**🟠 P1:** Nil map write\n\n<sub>Found by m</sub>']),
  );
  assert.deepEqual(c.set(statusContext)[0].slice(1), ['failure', '5 P0-P2 finding(s). See the AI review comment.']);
  assert.deepEqual([k.failures, k.warnings], [[], []]);
});

test('a head the PR has moved past gets no inline comments', async (t) => {
  clearAfter(t, 'REVIEWS');
  const reviewers = [['Claude', 'success', reviewJson({ findings: [nilMap] }), '', 'claude-opus-5-5']];
  const { c, k } = await publishWith(reviewers, { liveHead: 'fedcba9876543210' });
  assert.deepEqual([c.named('listReviewComments'), c.named('createReviewComment')], [[], []]);
  assert.ok(k.notices.includes('Skipped the inline comments on abcdef1, which is no longer the PR head.'));
  // The reviewed head still gets its verdict.
  assert.deepEqual(c.set(statusContext)[0].slice(0, 2), [sha, 'failure']);
  assert.deepEqual(k.failures, []);
});
