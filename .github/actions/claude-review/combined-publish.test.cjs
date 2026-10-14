'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, publish } = require('./claude-review.cjs');
const { sha, finding, routine, reviewJson, clearAfter, client, context, core } = require('./test-helpers.cjs');

const inputs = ['REVIEW_RESULT', 'FINDINGS', 'CODEX_RESULT', 'CODEX_FINDINGS', 'REVIEWER_CANDIDATES'];

// An input the step does not get is absent, not the string "undefined".
const setInput = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

// Publishes a Claude and a Codex result, as the verdict job passes them.
async function publishBoth({
  claude = ['success', reviewJson()],
  codex = ['success', reviewJson()],
  options = {},
} = {}) {
  for (const [name, value] of [
    ['REVIEW_RESULT', claude[0]],
    ['FINDINGS', claude[1]],
    ['CODEX_RESULT', codex[0]],
    ['CODEX_FINDINGS', codex[1]],
  ]) {
    setInput(name, value);
  }
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
  JSON.parse(
    Buffer.from(body.match(/\n<!-- claude-review-human ([A-Za-z0-9+/=]+) -->$/u)[1], 'base64').toString('utf8'),
  );

test('publish warns, but does not fail, when one review did not complete', async (t) => {
  clearAfter(t, ...inputs);
  for (const [claude, codex, missed, by] of [
    [['success', reviewJson()], ['failure', ''], 'Codex', 'Claude'],
    [['cancelled', ''], ['success', reviewJson()], 'Claude', 'Codex'],
  ]) {
    const { c, k } = await publishBoth({ claude, codex });
    assert.deepEqual(k.failures, [], missed);
    assert.deepEqual(k.warnings, [
      `The ${missed} review of abcdef1 did not complete, so the verdict is ${by}'s alone.`,
    ]);
    assert.deepEqual(
      c.set(statusContext).map(([, state]) => state),
      ['success'],
      missed,
    );
    assert.deepEqual(c.set(humanStatusContext), [[sha, 'success', 'No human review needed.']], missed);
  }
});

test('publish fails the job only when neither review completed', async (t) => {
  clearAfter(t, ...inputs);
  const { c, k, body } = await publishBoth({ claude: ['failure', ''], codex: ['failure', ''] });
  assert.deepEqual(k.failures, [`Neither the Claude nor the Codex review produced a verdict for ${sha}.`]);
  assert.deepEqual(k.warnings, []);
  assert.deepEqual(
    c.set(statusContext).map(([, state]) => state),
    ['error'],
  );
  assert.deepEqual(c.set(humanStatusContext), [
    [sha, 'pending', 'Needs human review: Neither the Claude nor the Codex review completed.'],
  ]);
  assert.match(body, /^<!-- claude-review-verdict -->\n### AI review: did not complete\n/u);
  assert.deepEqual(marked(body).reasons, ['Neither the Claude nor the Codex review completed.']);

  const p1 = await publishBoth({ codex: ['success', reviewJson({ findings: [finding('p1')] })] });
  assert.deepEqual(p1.k.failures, []);
  assert.deepEqual(
    p1.c.set(statusContext).map(([, state]) => state),
    ['failure'],
  );
});

test("a person is asked for either review's reasons, and the comment names who cleared the code", async (t) => {
  clearAfter(t, ...inputs);
  const asked = await publishBoth({
    claude: ['success', reviewJson({ human: routine })],
    codex: ['success', reviewJson({ human: question })],
  });
  assert.deepEqual(asked.c.set(humanStatusContext), [
    [sha, 'pending', 'Needs human review: Should the task role write every queue?'],
  ]);
  assert.ok(
    asked.body.includes('\n\nClaude and Codex found no P0-P2 problems at abcdef1, so the code needs no second review'),
  );
  assert.equal(marked(asked.body).cleared, true);

  const codexOnly = await publishBoth({ claude: ['failure', ''], codex: ['success', reviewJson({ human: question })] });
  assert.ok(
    codexOnly.body.includes('\n\nCodex found no P0-P2 problems at abcdef1, so the code needs no second review'),
  );
  const flagged = await publishBoth({ codex: ['success', reviewJson({ human: question, findings: [finding('p1')] })] });
  assert.doesNotMatch(flagged.body, /no second review/u);
  assert.equal(marked(flagged.body).cleared, false);
});

test('publish asks the reviewer Codex suggested when Claude suggested none', async (t) => {
  clearAfter(t, ...inputs);
  process.env.REVIEWER_CANDIDATES = '["alice","bob"]';
  const { c, body } = await publishBoth({
    claude: ['success', reviewJson({ human: question })],
    codex: ['success', reviewJson({ human: { ...question, reviewer: 'bob', reviewer_reason: 'owns the queues' } })],
  });
  assert.deepEqual(
    c.named('requestReviewers').map((r) => r.reviewers),
    [['bob']],
  );
  assert.match(body, /\n\nSuggested reviewer: `bob` \(owns the queues\)\. /u);
});

test('an empty Codex result publishes exactly what Claude alone does', async (t) => {
  clearAfter(t, ...inputs);
  const claude = ['success', reviewJson({ findings: [finding('p1')], human: question })];
  const alone = await publishBoth({ claude, codex: [] });
  for (const name of ['CODEX_RESULT', 'CODEX_FINDINGS']) assert.equal(process.env[name], undefined, name);
  const empty = await publishBoth({ claude, codex: ['', reviewJson()] });
  assert.match(alone.body, /^<!-- claude-review-verdict -->\n### Claude review: 1 P0-P2 finding\(s\)\n/u);
  assert.equal(empty.body, alone.body);
  assert.deepEqual(empty.c.named('createCommitStatus'), alone.c.named('createCommitStatus'));
  assert.deepEqual([empty.k.failures, empty.k.warnings], [[], []]);
});
