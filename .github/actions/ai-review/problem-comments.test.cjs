'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, publish } = require('./ai-review.cjs');
const { finding, reviewJson, useReviews, client, context, core } = require('./test-helpers.cjs');

const bot = { login: 'github-actions[bot]' };
const at = (path, line, severity, title, more = {}) => finding(severity, { path, line, title, ...more });

// Publishes a Claude, a Codex, and optionally a Gemini review, each given as
// its findings, and returns the inline comments as [path, line, body].
async function publishFindings(t, [claude, codex, gemini], options = {}) {
  useReviews(
    t,
    ['Claude', 'success', reviewJson({ findings: claude }), '', 'claude-opus-5-5'],
    ['Codex', 'success', reviewJson({ findings: codex }), '', 'gpt-6.1-sol'],
    ...(gemini ? [['Gemini', 'success', reviewJson({ findings: gemini }), '', 'gemini-3']] : []),
  );
  const c = client(options);
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  const posted = c.named('createReviewComment').map(({ path, line, body }) => [path, line, body]);
  return { c, k, posted };
}

test("a problem several models report gets one comment: its most severe finding's, signed by each", async (t) => {
  const { c, k, posted } = await publishFindings(t, [
    [at('internal/a.go', 10, 'p2', 'Cache fill skips the singleflight', { detail: 'Misses stampede.' })],
    [
      at('internal/a.go', 15, 'p1', 'Collapse concurrent cache misses', { detail: 'Each miss hits the origin.' }),
      at('docs/a.md', 3, 'p3', 'Typo'),
    ],
    [at('internal/a.go', 20, 'p2', 'Concurrent misses all fetch')],
  ]);
  assert.deepEqual(posted, [
    [
      'internal/a.go',
      15,
      '**🟠 P1:** Collapse concurrent cache misses\n\nEach miss hits the origin.\n\n<sub>Found by gpt-6.1-sol, claude-opus-5-5, and gemini-3</sub>',
    ],
    // A finding that stands alone keeps its own comment.
    ['docs/a.md', 3, '**⚪ P3:** Typo\n\n<sub>Found by gpt-6.1-sol</sub>'],
  ]);
  // The summary counts that problem once too.
  assert.deepEqual(c.set(statusContext)[0].slice(1), ['failure', '1 P0-P2 finding(s). See the AI review comment.']);
  assert.deepEqual([k.failures, k.warnings], [[], []]);
});

test("a problem's comment sits on a line, even when its most severe finding is on the whole file", async (t) => {
  const { posted } = await publishFindings(t, [
    [at('internal/jobs/export.go', 0, 'p1', 'Exports never consume the monthly quota')],
    [at('internal/handlers/exports.go', 104, 'p2', 'Exports are checked against the monthly quota but never counted')],
  ]);
  assert.deepEqual(posted, [
    [
      'internal/handlers/exports.go',
      104,
      '**🟡 P2:** Exports are checked against the monthly quota but never counted\n\n<sub>Found by claude-opus-5-5 and gpt-6.1-sol</sub>',
    ],
  ]);
});

test('a deferred problem gets no comment; one another model still blocks does, in its words', async (t) => {
  const answered = at('internal/a.go', 12, 'p2', 'Nil map write', { deferred: true });
  // Every model deferred it, or one deferred it and another rated it lower.
  for (const codex of [{ ...answered, line: 14, title: 'Map written early' }, at('internal/a.go', 14, 'p3', 'Map')]) {
    const { posted } = await publishFindings(t, [[answered], [codex]]);
    assert.deepEqual(posted, [], JSON.stringify(codex));
  }
  const blocked = await publishFindings(t, [[answered], [at('internal/a.go', 14, 'p2', 'Map written before make')]]);
  assert.deepEqual(blocked.posted, [
    ['internal/a.go', 14, '**🟡 P2:** Map written before make\n\n<sub>Found by claude-opus-5-5 and gpt-6.1-sol</sub>'],
  ]);
});

// Claude's and Codex's P1 at internal/a.go:12 and :14, one problem, which
// comments at Claude's line.
const merged = [[at('internal/a.go', 12, 'p1', 'Nil map write')], [at('internal/a.go', 14, 'p1', 'Map written early')]];
const earlier = (line, level, signers, user = bot) => ({
  user,
  path: 'internal/a.go',
  line,
  body: `**${level}:** Worded otherwise\n\n<sub>Found by ${signers}</sub>`,
});

test('a later push skips a problem where any model that reported it already commented at that line and level', async (t) => {
  for (const before of [
    // An earlier run's comments, one per model, or one signed by them and another.
    earlier(12, '🟠 P1', 'gpt-6.1-sol'),
    earlier(12, '🟠 P1', 'claude-opus-5-5'),
    earlier(12, '🟠 P1', 'gemini-3, gpt-6.1-sol, and claude-opus-5-5'),
  ]) {
    const { posted } = await publishFindings(t, merged, { reviewComments: [before] });
    assert.deepEqual(posted, [], JSON.stringify(before));
  }
  // A finding that stands alone is covered by a comment its model signed.
  const alone = await publishFindings(t, [merged[0], []], {
    reviewComments: [earlier(12, '🟠 P1', 'gpt-6.1-sol and claude-opus-5-5')],
  });
  assert.deepEqual(alone.posted, []);
});

test("another line, level, or model, or someone else's comment, never covers a problem", async (t) => {
  for (const before of [
    earlier(14, '🟠 P1', 'gpt-6.1-sol'),
    earlier(12, '🟡 P2', 'claude-opus-5-5 and gpt-6.1-sol'),
    earlier(12, '🟠 P1', 'gemini-3'),
    earlier(12, '🟠 P1', 'claude-opus-5-5', { login: 'mallory' }),
  ]) {
    const { posted } = await publishFindings(t, merged, { reviewComments: [before] });
    assert.deepEqual(
      posted.map(([path, line]) => [path, line]),
      [['internal/a.go', 12]],
      JSON.stringify(before),
    );
  }
});

test('a model whose name holds "and" still matches its own earlier comment', async (t) => {
  const model = 'research and development';
  useReviews(t, ['Claude', 'success', reviewJson({ findings: [merged[0][0]] }), '', model]);
  for (const [signers, count] of [
    [model, 0],
    ['research', 1],
  ]) {
    const c = client({ reviewComments: [earlier(12, '🟠 P1', signers)] });
    await publish({ github: c.github, context: context(), core: core() });
    assert.equal(c.named('createReviewComment').length, count, signers);
  }
});
