'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { marker, verdict } = require('./ai-review.cjs');
const { sha, url, finding, routine, reviewJson } = require('./test-helpers.cjs');

// The verdict from Claude's and Codex's results, given as [result, output],
// with no merge, so the comment combines the reviews itself.
const pair = (claude, codex, candidates = []) =>
  verdict(
    [
      { name: 'Claude', result: claude[0], output: claude[1] },
      { name: 'Codex', result: codex[0], output: codex[1] },
    ],
    sha,
    url,
    candidates,
  );
// The verdict from a Claude and a Codex review that both completed.
const both = (claude, codex, candidates = ['alice', 'bob']) =>
  pair(['success', reviewJson(claude)], ['success', reviewJson(codex)], candidates);
const asks = (reasons, reviewer = '', why = '') => ({ needed: true, reasons, reviewer, reviewer_reason: why });
const ran =
  "**Not checked:** The AI review read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.";

test('two passing reviews read as one AI review, with the first summary and no names', () => {
  const v = both(
    { findings: [finding('p3')], notChecked: ['Staging.'] },
    {
      summary: 'Caches lookups.',
      findings: [finding('pre_existing', { path: 'docs/a.md', line: 0 }), finding('P3', { title: 'nil map write.' })],
      notChecked: ['Staging.', 'Load.'],
    },
  );
  assert.equal(v.state, 'success');
  assert.equal(v.description, 'No P0-P2 findings (1 P3, 1 pre-existing).');
  assert.ok(
    v.body.startsWith(
      `${marker}\n### AI review: no P0-P2 findings\n\nReviewed abcdef1. [Run log](${url})\n\nAdds a cache.\n\n**⚪ P3**\n- \`internal/a.go:12\` Nil map write\n\n**🟣 Pre-existing**\n- \`docs/a.md\` Nil map write\n`,
    ),
  );
  assert.ok(v.body.endsWith(`\n\n${ran}\n- Staging.\n- Load.`));
  assert.doesNotMatch(v.body, /Claude|Codex|Caches lookups/u);
  assert.deepEqual([v.by, v.missed], ['Claude and Codex', []]);
});

test('a P0-P2 finding from either review fails the verdict, counted once however many reported it', () => {
  for (const [claude, codex, n] of [
    [[finding('p1')], [finding('p3')], 1],
    [[finding('p3')], [finding('p0')], 1],
    [[finding('p2')], [finding('p2', { title: 'Unchecked error' })], 2],
    [[finding('p1')], [finding('p1', { title: ' nil MAP write ' })], 1],
    // The same problem at different severities stays twice without a merge.
    [[finding('p1')], [finding('p2')], 2],
  ]) {
    const v = both({ findings: claude }, { findings: codex });
    assert.equal(v.state, 'failure', JSON.stringify([claude, codex]));
    assert.equal(v.description, `${n} P0-P2 finding(s). See the AI review comment.`);
    assert.ok(v.body.startsWith(`${marker}\n### AI review: ${n} P0-P2 finding(s)\n`));
    assert.ok(v.body.includes(`\n\n${ran}\n\nPush a fix`));
    assert.match(v.body, /add the `ai-review-override` label to accept abcdef1 as is/u);
  }
});

test('either review can ask for a person, and their reasons and gaps merge without repeats', () => {
  const v = both(
    { human: asks(['Changes billing.', 'Adds a table.']), notChecked: ['A.', 'B.', 'C.'] },
    { human: asks(['Changes billing.', 'Drops a column.', 'D.', 'E.']), notChecked: ['C.', 'D.', 'E.', 'F.'] },
  );
  assert.deepEqual(v.reasons, ['Changes billing.', 'Adds a table.', 'Drops a column.', 'D.', 'E.']);
  assert.ok(v.body.endsWith(`\n\n${ran}\n- A.\n- B.\n- C.\n- D.\n- E.`));
  assert.deepEqual(both({}, { human: asks(['Changes billing.']) }).reasons, ['Changes billing.']);
  assert.deepEqual(both({ human: asks([]) }, { human: asks([]) }).reasons, ['The AI review asked for a human review.']);
  assert.deepEqual(both({}, { human: null }).reasons, ['The AI review did not say whether this needs a human review.']);
  assert.deepEqual(both({}, {}).reasons, []);
});

test("the suggested reviewer is the first review's pick, then the next's, then the one with the most history", () => {
  const picks = (claude, codex, candidates) =>
    both({ human: asks(['x'], ...claude) }, { human: asks(['x'], ...codex) }, candidates).reviewer;
  assert.deepEqual(picks(['bob', 'wrote billing'], ['alice', 'owns it']), { login: 'bob', why: 'wrote billing' });
  assert.deepEqual(picks(['mallory', 'x'], ['alice', 'owns it']), { login: 'alice', why: 'owns it' });
  assert.deepEqual(picks([''], [' @Bob ']), { login: 'bob', why: 'the AI review suggested them' });
  assert.deepEqual(picks(['mallory'], ['eve']), { login: 'alice', why: 'most recent history in the changed files' });
  assert.equal(picks(['bob'], ['alice'], []), null);
});

test('the code is cleared only when every review read it closely and asks a person only with reasons', () => {
  const question = asks(['Should the task role write every queue?']);
  for (const [claude, codex] of [
    [{ human: question }, { human: question }],
    [{ human: question }, { human: routine }],
    [{ human: routine }, { human: question }],
  ]) {
    assert.equal(both(claude, codex).cleared, true, JSON.stringify([claude, codex]));
  }
  for (const [why, claude, codex] of [
    ['neither asks', { human: routine }, { human: routine }],
    ['Codex did not read closely', { human: question }, { closely: false }],
    ['Claude did not say how closely', { human: question, closely: null }, {}],
    ['Codex asks without reasons', { human: question }, { human: asks([]) }],
    ['Codex did not decide', { human: question }, { human: null }],
    ['Codex found a P1', { human: question }, { human: question, findings: [finding('p1')] }],
  ]) {
    assert.ok(!both(claude, codex).cleared, why);
  }
});

test('a review that did not complete leaves the verdict to the other, and only the run log says so', () => {
  const codexOnly = pair(
    ['failure', ''],
    ['success', reviewJson({ summary: 'Caches lookups.', findings: [finding('p3')], notChecked: ['Load.'] })],
  );
  assert.equal(codexOnly.state, 'success');
  assert.equal(codexOnly.description, 'No P0-P2 findings (1 P3, 0 pre-existing).');
  assert.ok(
    codexOnly.body.startsWith(
      `${marker}\n### AI review: no P0-P2 findings\n\nReviewed abcdef1. [Run log](${url})\n\nCaches lookups.\n\n**⚪ P3**\n`,
    ),
  );
  assert.ok(codexOnly.body.endsWith(`\n\n${ran}\n- Load.`));
  assert.doesNotMatch(codexOnly.body, /Claude|Codex|did not complete/u);
  assert.deepEqual([codexOnly.reasons, codexOnly.missed, codexOnly.by], [[], ['Claude'], 'Codex']);

  const claudeOnly = pair(['success', reviewJson({ findings: [finding('p1')] })], ['failure', '']);
  assert.equal(claudeOnly.state, 'failure');
  assert.equal(claudeOnly.description, '1 P0-P2 finding(s). See the AI review comment.');
  assert.doesNotMatch(claudeOnly.body, /Claude|Codex|did not complete/u);
  assert.deepEqual(claudeOnly.reasons, []);
  for (const output of ['', 'not json', JSON.stringify({ findings: [] }), reviewJson({ findings: [finding('nit')] })]) {
    const v = pair(['success', reviewJson()], ['success', output]);
    assert.deepEqual([v.state, v.missed], ['success', ['Codex']], output);
  }
});

test('neither review completing is an error that waits for a person', () => {
  const v = pair(['failure', ''], ['cancelled', reviewJson()], ['alice']);
  assert.equal(v.state, 'error');
  assert.equal(v.description, 'Review did not complete. Re-run it, or have a writer approve this commit.');
  assert.ok(
    v.body.startsWith(`${marker}\n### AI review: did not complete\n\nReviewing abcdef1 failed. [Run log](${url})`),
  );
  assert.deepEqual(v.reasons, ['No AI review completed.']);
  assert.deepEqual(v.reviewer, { login: 'alice', why: 'most recent history in the changed files' });
  assert.deepEqual(v.missed, ['Claude', 'Codex']);
});

test('untrusted text is capped at the lengths the schema allows', () => {
  const long = {
    summary: 's'.repeat(1501),
    findings: [finding('p3', { title: 't'.repeat(201), path: 'p'.repeat(301) })],
    human: asks(['r'.repeat(201)], 'bob', 'w'.repeat(250)),
    notChecked: ['n'.repeat(201)],
  };
  const v = both(long, {});
  assert.ok(v.body.includes(`\n\n${'s'.repeat(1499)}…\n`));
  assert.ok(v.body.includes(`\n- \`${'p'.repeat(299)}…:12\` ${'t'.repeat(199)}…\n`));
  assert.ok(v.body.endsWith(`\n- ${'n'.repeat(199)}…`));
  assert.deepEqual(v.reasons, [`${'r'.repeat(199)}…`]);
  assert.deepEqual(v.reviewer, { login: 'bob', why: 'w'.repeat(200) });

  // Characters count as the schema counts them, so text at the limit stays whole.
  const at = {
    summary: 's'.repeat(1500),
    findings: [finding('p3', { title: '🔥'.repeat(200), path: 'p'.repeat(300) })],
    human: asks(['🔥'.repeat(200)]),
    notChecked: ['n'.repeat(200)],
  };
  const alone = verdict([{ name: 'Claude', result: 'success', output: reviewJson(at) }], sha, url);
  for (const whole of [both(at, at), alone]) {
    assert.doesNotMatch(whole.body, /…/u);
    assert.deepEqual(whole.reasons, ['🔥'.repeat(200)]);
  }
});
