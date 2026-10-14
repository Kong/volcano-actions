'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { marker, verdict } = require('./ai-review.cjs');
const { sha, url, finding, routine, reviewJson } = require('./test-helpers.cjs');

const names = ['Claude', 'Codex', 'Gemini'];
// The verdict from three reviewers' results, given as [result, output] or, for
// one that completed, its reviewJson options.
const three = (results, candidates = ['alice', 'bob']) =>
  verdict(
    results.map((r, i) => ({
      name: names[i],
      ...(Array.isArray(r) ? { result: r[0], output: r[1] } : { result: 'success', output: reviewJson(r) }),
    })),
    sha,
    url,
    candidates,
  );
const asks = (reasons, reviewer = '', why = '') => ({ needed: true, reasons, reviewer, reviewer_reason: why });
const ran =
  "**Not checked:** The AI review read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.";

test('three reviews read as one AI review, shaped as one would', () => {
  const v = three([
    { findings: [finding('p3')] },
    { summary: 'Caches lookups.' },
    { summary: 'Adds a lookup cache.', findings: [finding('pre_existing', { path: 'docs/a.md', line: 0 })] },
  ]);
  assert.equal(v.state, 'success');
  assert.equal(v.description, 'No P0-P2 findings (1 P3, 1 pre-existing).');
  assert.ok(
    v.body.startsWith(
      `${marker}\n### AI review: no P0-P2 findings\n\nReviewed abcdef1. [Run log](${url})\n\nAdds a cache.\n\n**⚪ P3**\n- \`internal/a.go:12\` Nil map write\n\n**🟣 Pre-existing**\n- \`docs/a.md\` Nil map write\n`,
    ),
  );
  assert.ok(v.body.endsWith(`\n\n${ran}`));
  assert.doesNotMatch(v.body, /Claude|Codex|Gemini/u);
  assert.equal(v.by, 'Claude, Codex, and Gemini');
});

test('a P0-P2 finding from any review fails the verdict, and every distinct finding counts', () => {
  for (const at of [0, 1, 2]) {
    const results = [{}, {}, {}];
    results[at] = { findings: [finding('p2'), finding('p3')] };
    const v = three(results);
    assert.equal(v.state, 'failure', names[at]);
    assert.equal(v.description, '1 P0-P2 finding(s). See the AI review comment.');
    assert.match(v.body, /\*\*🟡 P2\*\*\n- `internal\/a\.go:12` Nil map write\n/u);
  }
  const all = three([
    { findings: [finding('p0')] },
    { findings: [finding('p1')] },
    { findings: [finding('p1'), finding('p1', { line: 30 })] },
  ]);
  assert.equal(all.description, '3 P0-P2 finding(s). See the AI review comment.');
  assert.equal(all.body.match(/\n- `internal\/a\.go:\d+` Nil map write/gu).length, 3);
});

test('any review can ask for a person, and reasons and gaps merge without repeats', () => {
  const v = three([
    { human: asks(['A?', 'B?']), notChecked: ['X.'] },
    { human: routine, notChecked: ['X.', 'Y.'] },
    { human: asks(['B?', 'C?', 'D?', 'E?', 'F?']), notChecked: ['Z.', 'W.', 'V.', 'U.'] },
  ]);
  assert.deepEqual(v.reasons, ['A?', 'B?', 'C?', 'D?', 'E?']);
  assert.ok(v.body.endsWith(`\n\n${ran}\n- X.\n- Y.\n- Z.\n- W.\n- V.`));
  assert.deepEqual(three([{}, {}, { human: null }]).reasons, [
    'The AI review did not say whether this needs a human review.',
  ]);
  assert.deepEqual(three([{}, {}, {}]).reasons, []);
});

test("the suggested reviewer is the first review's pick among the candidates", () => {
  const picks = (...reviewers) => three(reviewers.map((r) => ({ human: asks(['x'], ...r) }))).reviewer;
  assert.deepEqual(picks(['mallory'], [''], ['bob', 'owns it']), { login: 'bob', why: 'owns it' });
  assert.deepEqual(picks(['mallory'], ['alice', 'wrote it'], ['bob', 'owns it']), { login: 'alice', why: 'wrote it' });
  assert.deepEqual(picks(['eve'], ['mallory'], ['trent']), {
    login: 'alice',
    why: 'most recent history in the changed files',
  });
});

test('the code is cleared only when every completed review would clear it', () => {
  const question = asks(['Should the task role write every queue?']);
  assert.equal(three([{ human: routine }, { human: question }, { human: routine }]).cleared, true);
  assert.equal(three([{ human: routine }, { human: question }, ['failure', '']]).cleared, true);
  assert.ok(!three([{ human: question }, { human: question }, { closely: false }]).cleared);
  assert.ok(!three([{ human: question }, {}, { human: asks([]) }]).cleared);
  assert.ok(!three([{ human: routine }, { human: routine }, { human: routine }]).cleared);
});

test('reviews that did not complete leave the verdict to the rest, without a mark in the comment', () => {
  const one = three([{ findings: [finding('p3')] }, ['failure', ''], { notChecked: ['Load.'] }]);
  assert.equal(one.state, 'success');
  assert.equal(one.description, 'No P0-P2 findings (1 P3, 0 pre-existing).');
  assert.ok(one.body.endsWith(`\n\n${ran}\n- Load.`));
  assert.doesNotMatch(one.body, /Claude|Codex|Gemini|did not complete/u);
  assert.deepEqual([one.reasons, one.missed, one.by], [[], ['Codex'], 'Claude and Gemini']);

  const two = three([['cancelled', reviewJson()], { findings: [finding('p1')] }, ['success', 'not json']]);
  assert.equal(two.state, 'failure');
  assert.equal(two.description, '1 P0-P2 finding(s). See the AI review comment.');
  assert.match(two.body, /\n\n\*\*🟠 P1\*\*\n- `internal\/a\.go:12` Nil map write\n/u);
  assert.doesNotMatch(two.body, /Claude|Codex|Gemini|did not complete/u);
  assert.deepEqual([two.reasons, two.missed, two.by], [[], ['Claude', 'Gemini'], 'Codex']);
});

test('no review completing is an error that waits for a person', () => {
  const v = three(
    [
      ['failure', ''],
      ['cancelled', reviewJson()],
      ['success', reviewJson({ findings: [finding('nit')] })],
    ],
    ['alice'],
  );
  assert.equal(v.state, 'error');
  assert.equal(v.description, 'Review did not complete. Re-run it, or have a writer approve this commit.');
  assert.ok(v.body.startsWith(`${marker}\n### AI review: did not complete\n\nReviewing abcdef1 failed.`));
  assert.deepEqual(v.reasons, ['No AI review completed.']);
  assert.deepEqual(v.reviewer, { login: 'alice', why: 'most recent history in the changed files' });
  assert.deepEqual(v.missed, names);
  // So is a verdict with no reviewer at all, as when the workflow lists none.
  assert.deepEqual(verdict([], sha, url).reasons, ['No AI review completed.']);
});
