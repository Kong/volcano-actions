'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { marker, verdict } = require('./claude-review.cjs');
const { sha, url, finding, routine, reviewJson } = require('./test-helpers.cjs');

// The verdict from a Claude and a Codex review that both completed.
const both = (claude, codex, candidates = ['alice', 'bob']) =>
  verdict('success', reviewJson(claude), sha, url, candidates, { result: 'success', output: reviewJson(codex) });
const asks = (reasons, reviewer = '', why = '') => ({ needed: true, reasons, reviewer, reviewer_reason: why });
const ranBoth =
  "**Not checked:** Claude and Codex read the diff, the code, and the PR's text; they ran no tests or builds and read nothing outside this repository.";

test("without a Codex result the verdict is Claude's alone, as before", () => {
  for (const [result, raw] of [
    ['success', reviewJson({ findings: [finding('p3')], notChecked: ['Staging.'] })],
    ['success', reviewJson({ findings: [finding('p1')], human: asks(['Changes billing.'], 'bob') })],
    ['failure', ''],
  ]) {
    const alone = verdict(result, raw, sha, url, ['alice', 'bob']);
    for (const codex of [{}, { result: '' }, { result: '', output: reviewJson() }, null]) {
      assert.deepEqual(verdict(result, raw, sha, url, ['alice', 'bob'], codex), alone, JSON.stringify(codex));
    }
    assert.match(alone.body, /^<!-- claude-review-verdict -->\n### Claude review: /u);
    assert.doesNotMatch(alone.body, /Codex|\(Claude\)|\*\*Claude:\*\*|AI review/u);
  }
});

test('two passing reviews make one AI review that says whose each item is', () => {
  const v = both(
    { findings: [finding('p3')], notChecked: ['Staging.'] },
    {
      summary: 'Caches lookups.',
      findings: [finding('pre_existing', { path: 'docs/a.md', line: 0 })],
      notChecked: ['Staging.', 'Load.'],
    },
  );
  assert.equal(v.state, 'success');
  assert.equal(v.description, 'No P0-P2 findings (1 P3, 1 pre-existing).');
  assert.ok(
    v.body.startsWith(
      `${marker}\n### AI review: no P0-P2 findings\n\nReviewed abcdef1. [Run log](${url})\n\n**Claude:** Adds a cache.\n\n**Codex:** Caches lookups.\n`,
    ),
  );
  assert.match(v.body, /\*\*⚪ P3\*\*\n- `internal\/a.go:12` Nil map write \(Claude\)\n/u);
  assert.match(v.body, /\*\*🟣 Pre-existing\*\*\n- `docs\/a.md` Nil map write \(Codex\)\n/u);
  assert.ok(v.body.endsWith(`\n\n${ranBoth}\n- Staging.\n- Load.`));
  assert.equal(v.by, 'Claude and Codex');
  assert.deepEqual(v.missed, []);
});

test('a P0-P2 finding from either review fails the verdict', () => {
  for (const [claude, codex] of [
    [[finding('p1')], [finding('p3')]],
    [[finding('p3')], [finding('p0')]],
    [[finding('p2')], [finding('p2', { title: 'Unchecked error' })]],
  ]) {
    const v = both({ findings: claude }, { findings: codex });
    const n = [...claude, ...codex].filter((f) => f.severity !== 'p3').length;
    assert.equal(v.state, 'failure', JSON.stringify([claude, codex]));
    assert.equal(v.description, `${n} P0-P2 finding(s). See the AI review comment.`);
    assert.ok(v.body.startsWith(`${marker}\n### AI review: ${n} P0-P2 finding(s)\n`));
    assert.ok(v.body.includes(`\n\n${ranBoth}\n\nPush a fix`));
    assert.match(v.body, /add the `claude-review-override` label to accept abcdef1 as is/u);
  }
});

test('either review can ask for a person, and their reasons and gaps merge without repeats', () => {
  const v = both(
    { human: asks(['Changes billing.', 'Adds a table.']), notChecked: ['A.', 'B.', 'C.'] },
    { human: asks(['Changes billing.', 'Drops a column.', 'D.', 'E.']), notChecked: ['C.', 'D.', 'E.', 'F.'] },
  );
  assert.deepEqual(v.reasons, ['Changes billing.', 'Adds a table.', 'Drops a column.', 'D.', 'E.']);
  assert.ok(v.body.endsWith(`\n\n${ranBoth}\n- A.\n- B.\n- C.\n- D.\n- E.`));
  assert.deepEqual(both({}, { human: asks(['Changes billing.']) }).reasons, ['Changes billing.']);
  assert.deepEqual(both({ human: asks([]) }, {}).reasons, ['Claude asked for a human review.']);
  assert.deepEqual(both({}, { human: null }).reasons, ['Codex did not say whether this needs a human review.']);
  assert.deepEqual(both({}, {}).reasons, []);
});

test("the suggested reviewer is Claude's pick, then Codex's, then the one with the most history", () => {
  const picks = (claude, codex, candidates) =>
    both({ human: asks(['x'], ...claude) }, { human: asks(['x'], ...codex) }, candidates).reviewer;
  assert.deepEqual(picks(['bob', 'wrote billing'], ['alice', 'owns it']), { login: 'bob', why: 'wrote billing' });
  assert.deepEqual(picks(['mallory', 'x'], ['alice', 'owns it']), { login: 'alice', why: 'owns it' });
  assert.deepEqual(picks([''], [' @Bob ']), { login: 'bob', why: 'Codex suggested them' });
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

test('a review that did not complete leaves the verdict to the other, without blocking or a reason', () => {
  const codexOnly = verdict('failure', '', sha, url, [], {
    result: 'success',
    output: reviewJson({ findings: [finding('p3')], notChecked: ['Load.'] }),
  });
  assert.equal(codexOnly.state, 'success');
  assert.equal(codexOnly.description, 'No P0-P2 findings (1 P3, 0 pre-existing; Codex only; Claude did not complete).');
  assert.ok(
    codexOnly.body.startsWith(
      `${marker}\n### AI review: no P0-P2 findings\n\nReviewed abcdef1. [Run log](${url})\n\nClaude review did not complete. [Run log](${url})\n\n**Codex:** Adds a cache.\n`,
    ),
  );
  assert.match(codexOnly.body, / Nil map write \(Codex\)\n/u);
  assert.ok(
    codexOnly.body.endsWith(
      "\n\n**Not checked:** Codex read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.\n- Load.",
    ),
  );
  assert.deepEqual([codexOnly.reasons, codexOnly.missed, codexOnly.by], [[], ['Claude'], 'Codex']);

  const claudeOnly = verdict('success', reviewJson({ findings: [finding('p1')] }), sha, url, [], { result: 'failure' });
  assert.equal(claudeOnly.state, 'failure');
  assert.equal(
    claudeOnly.description,
    '1 P0-P2 finding(s) (Claude only; Codex did not complete). See the AI review comment.',
  );
  assert.match(
    claudeOnly.body,
    /\n\nCodex review did not complete\. \[Run log\]\(.*\)\n\n\*\*Claude:\*\* Adds a cache\.\n/u,
  );
  assert.deepEqual(claudeOnly.reasons, []);
  for (const output of ['', 'not json', JSON.stringify({ findings: [] }), reviewJson({ findings: [finding('nit')] })]) {
    const v = verdict('success', reviewJson(), sha, url, [], { result: 'success', output });
    assert.deepEqual([v.state, v.missed], ['success', ['Codex']], output);
  }
});

test('neither review completing is an error that waits for a person', () => {
  const v = verdict('failure', '', sha, url, ['alice'], { result: 'cancelled', output: reviewJson() });
  assert.equal(v.state, 'error');
  assert.equal(v.description, 'Review did not complete. Re-run it, or have a writer approve this commit.');
  assert.ok(
    v.body.startsWith(`${marker}\n### AI review: did not complete\n\nReviewing abcdef1 failed. [Run log](${url})`),
  );
  assert.deepEqual(v.reasons, ['Neither the Claude nor the Codex review completed.']);
  assert.deepEqual(v.reviewer, { login: 'alice', why: 'most recent history in the changed files' });
  assert.deepEqual(v.missed, ['Claude', 'Codex']);
});

test("untrusted Codex text is capped at the lengths Claude's schema allows", () => {
  const v = both(
    {},
    {
      summary: 's'.repeat(1501),
      findings: [finding('p3', { title: 't'.repeat(201), path: 'p'.repeat(301) })],
      human: asks(['r'.repeat(201)], 'bob', 'w'.repeat(250)),
      notChecked: ['n'.repeat(201)],
    },
  );
  assert.ok(v.body.includes(`\n\n**Codex:** ${'s'.repeat(1499)}…\n`));
  assert.ok(v.body.includes(`\n- \`${'p'.repeat(299)}…:12\` ${'t'.repeat(199)}… (Codex)\n`));
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
  for (const whole of [both(at, at), verdict('success', reviewJson(at), sha, url)]) {
    assert.doesNotMatch(whole.body, /…/u);
    assert.deepEqual(whole.reasons, ['🔥'.repeat(200)]);
  }
});
