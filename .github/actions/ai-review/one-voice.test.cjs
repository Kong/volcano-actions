'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, publish, override, gate } = require('./ai-review.cjs');
const { finding, reviewJson, needsOf, clearAfter, client, context, core } = require('./test-helpers.cjs');

// Every reviewer and provider name the tests use. None may reach what the
// review publishes, only the run log.
const names = /\b(?:claude|codex|gemini|mistral|anthropic|openai)\b/iu;
const candidates = '["alice","bob"]';
// Asks for a person without a reason of its own, and picks a reviewer without
// saying why, so every fallback text shows.
const vague = { needed: true, reasons: [], reviewer: 'bob', reviewer_reason: '' };
const question = { needed: true, reasons: ['Should the queue be shared?'], reviewer: '', reviewer_reason: '' };
const blocking = reviewJson({ findings: [finding('p1'), finding('p3')], human: vague });
const clean = reviewJson({ findings: [finding('p3')], human: question });
const failed = ['failure', ''];
const ok = (output) => ['success', output];

// The verdict job's needs for [name, result, output] reviewers, plus a
// skipped job named only by its ID.
const needs = (reviewers, skipped = false) =>
  JSON.stringify({
    ...JSON.parse(needsOf(...reviewers.map(([name, result, output]) => [name, result, output, candidates]))),
    ...(skipped && { mistral: { result: 'skipped' } }),
  });

// Everything a run published as the AI review: status descriptions, comment
// bodies, the decision each comment records, and review requests. Inline
// comments are each reviewer's own, signed by its model, so they are not here.
function published(c) {
  const bodies = [...c.named('createComment'), ...c.named('updateComment')].map((x) => x.body);
  const decisions = bodies.map((body) =>
    Buffer.from(body.match(/<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u)[1], 'base64').toString('utf8'),
  );
  return [
    ...c.named('createCommitStatus').map((s) => s.description),
    ...bodies,
    ...decisions,
    ...c.named('requestReviewers').map((r) => JSON.stringify(r)),
  ];
}

// [case, reviewers, the skipped job, who did not complete]
const runs = [
  ['one that completed', [['Claude', ...ok(blocking)]], false, []],
  ['one that did not', [['Claude', ...failed]], false, ['Claude']],
  [
    'two that completed',
    [
      ['Claude', ...ok(blocking)],
      ['Codex', ...ok(clean)],
    ],
    false,
    [],
  ],
  [
    'two, one incomplete',
    [
      ['Claude', ...ok(clean)],
      ['Codex', ...failed],
    ],
    false,
    ['Codex'],
  ],
  [
    'two that did not',
    [
      ['Claude', ...failed],
      ['Codex', 'cancelled', clean],
    ],
    false,
    ['Claude', 'Codex'],
  ],
  [
    'three that completed',
    [
      ['Claude', ...ok(blocking)],
      ['Codex', ...ok(clean)],
      ['Gemini', ...ok(clean)],
    ],
    false,
    [],
  ],
  [
    'three, two incomplete',
    [
      ['Claude', ...ok(blocking)],
      ['Gemini', ...failed],
    ],
    true,
    ['Gemini', 'Mistral'],
  ],
  [
    'three that did not',
    [
      ['Claude', ...failed],
      ['Gemini', ...failed],
    ],
    true,
    ['Claude', 'Gemini', 'Mistral'],
  ],
];

test('nothing the review publishes names a reviewer, however many ran or completed', async (t) => {
  clearAfter(t, 'REVIEWS');
  for (const [why, reviewers, skipped, missed] of runs) {
    process.env.REVIEWS = needs(reviewers, skipped);
    const c = client();
    const k = core();
    await publish({ github: c.github, context: context(), core: k });
    const out = published(c);
    assert.ok(out.length >= 4, why);
    for (const text of out) assert.doesNotMatch(text, names, `${why}: ${text}`);
    // The run log names each review that did not complete.
    assert.deepEqual(
      k.warnings.map((w) => w.match(/^The (\w+) review of abcdef1 did not complete/u)?.[1]),
      missed,
      why,
    );
  }
});

test('nor does an override or a later human gate', async (t) => {
  clearAfter(t, 'REVIEWS');
  process.env.REVIEWS = needs([
    ['Claude', ...ok(blocking)],
    ['Codex', ...ok(clean)],
  ]);
  const c = client();
  await publish({ github: c.github, context: context(), core: core() });
  const [{ body }] = c.named('createComment');
  const later = client({
    comments: [{ id: 2, user: { login: 'github-actions[bot]' }, body }],
    statuses: [{ context: statusContext, state: 'failure' }],
  });
  await override({
    github: later.github,
    context: context({ sender: { login: 'author', type: 'User' } }),
    core: core(),
  });
  await gate({ github: later.github, context: context({ action: 'labeled' }), core: core() });
  for (const text of [...published(c), ...published(later)]) assert.doesNotMatch(text, names, text);
  assert.ok(later.named('createCommitStatus').length >= 3);
});
