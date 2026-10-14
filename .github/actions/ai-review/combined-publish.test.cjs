'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, publish } = require('./ai-review.cjs');
const { sha, finding, routine, reviewJson, needsOf, clearAfter, client, context, core } = require('./test-helpers.cjs');

// Publishes a Claude and a Codex result, as the verdict job passes them.
async function publishBoth({
  claude = ['success', reviewJson()],
  codex = ['success', reviewJson()],
  candidates = '',
  options = {},
} = {}) {
  process.env.REVIEWS = needsOf(['Claude', ...claude, candidates], ['Codex', ...codex, candidates]);
  const c = client(options);
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  return { c, k, body: c.named('createComment')[0]?.body };
}

const question = {
  needed: true,
  reasons: ['Should the task role write every queue?'],
  reviewer: '',
  reviewer_reason: '',
};
const marked = (body) =>
  JSON.parse(Buffer.from(body.match(/\n<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u)[1], 'base64').toString('utf8'));

test('publish warns, but does not fail, when one review did not complete', async (t) => {
  clearAfter(t, 'REVIEWS');
  for (const [claude, codex, missed, by] of [
    [['success', reviewJson()], ['failure', ''], 'Codex', 'Claude'],
    [['cancelled', ''], ['success', reviewJson()], 'Claude', 'Codex'],
  ]) {
    const { c, k } = await publishBoth({ claude, codex });
    assert.deepEqual(k.failures, [], missed);
    assert.deepEqual(k.warnings, [`The ${missed} review of abcdef1 did not complete, so the verdict rests on ${by}.`]);
    assert.deepEqual(
      c.set(statusContext).map(([, state]) => state),
      ['success'],
      missed,
    );
    assert.deepEqual(c.set(humanStatusContext), [[sha, 'success', 'No human review needed.']], missed);
  }
});

test('publish fails the job only when neither review completed', async (t) => {
  clearAfter(t, 'REVIEWS');
  const { c, k, body } = await publishBoth({ claude: ['failure', ''], codex: ['failure', ''] });
  assert.deepEqual(k.failures, [`No AI review produced a verdict for ${sha}.`]);
  assert.deepEqual(k.warnings, [
    'The Claude review of abcdef1 did not complete.',
    'The Codex review of abcdef1 did not complete.',
  ]);
  assert.deepEqual(
    c.set(statusContext).map(([, state]) => state),
    ['error'],
  );
  assert.deepEqual(c.set(humanStatusContext), [[sha, 'pending', 'Needs human review: No AI review completed.']]);
  assert.match(body, /^<!-- ai-review-verdict -->\n### AI review: did not complete\n/u);
  assert.deepEqual(marked(body).reasons, ['No AI review completed.']);

  const p1 = await publishBoth({ codex: ['success', reviewJson({ findings: [finding('p1')] })] });
  assert.deepEqual(p1.k.failures, []);
  assert.deepEqual(
    p1.c.set(statusContext).map(([, state]) => state),
    ['failure'],
  );
});

test("a person is asked for either review's reasons, and the comment says the AI review cleared the code", async (t) => {
  clearAfter(t, 'REVIEWS');
  const asked = await publishBoth({
    claude: ['success', reviewJson({ human: routine })],
    codex: ['success', reviewJson({ human: question })],
  });
  assert.deepEqual(asked.c.set(humanStatusContext), [
    [sha, 'pending', 'Needs human review: Should the task role write every queue?'],
  ]);
  const cleared = '\n\nThe AI review found no P0-P2 problems at abcdef1, so the code needs no second review';
  assert.ok(asked.body.includes(cleared));
  assert.equal(marked(asked.body).cleared, true);

  const codexOnly = await publishBoth({ claude: ['failure', ''], codex: ['success', reviewJson({ human: question })] });
  assert.ok(codexOnly.body.includes(cleared));
  const flagged = await publishBoth({ codex: ['success', reviewJson({ human: question, findings: [finding('p1')] })] });
  assert.doesNotMatch(flagged.body, /no second review/u);
  assert.equal(marked(flagged.body).cleared, false);
});

test('publish asks the reviewer Codex suggested when Claude suggested none', async (t) => {
  clearAfter(t, 'REVIEWS');
  const { c, body } = await publishBoth({
    candidates: '["alice","bob"]',
    claude: ['success', reviewJson({ human: question })],
    codex: ['success', reviewJson({ human: { ...question, reviewer: 'bob', reviewer_reason: 'owns the queues' } })],
  });
  assert.deepEqual(
    c.named('requestReviewers').map((r) => r.reviewers),
    [['bob']],
  );
  assert.match(body, /\n\nSuggested reviewer: `bob` \(owns the queues\)\. /u);
});
