'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { marker, verdict, globRegExp } = require('./ai-review.cjs');
const { readRepo, sha, url, finding, output, routine } = require('./test-helpers.cjs');

// The verdict when Claude is the only reviewer, which reads as it did before
// the review took several, apart from the AI review's names.
const claude = (result, raw, candidates) => verdict([{ name: 'Claude', result, output: raw }], sha, url, candidates);

test('a failed, empty, or malformed review is an error that replaces the summary', () => {
  for (const [result, raw] of [
    ['failure', output([])],
    ['success', ''],
    ['success', 'not json'],
    ['success', JSON.stringify({ findings: [] })],
    ['success', JSON.stringify({ summary: 'ok', findings: {} })],
    ['success', output([finding('critical')])],
    ['success', output([finding('important')])],
    ['success', output([finding('nit')])],
    ['success', output([finding('p4')])],
    ['success', output([finding('P 1')])],
    ['success', output([finding()])],
    ['success', output([null])],
  ]) {
    const v = claude(result, raw);
    assert.equal(v.state, 'error', `${result} ${raw}`);
    assert.ok(v.body.startsWith(`${marker}\n### AI review: did not complete\n`), `${result} ${raw}`);
    assert.match(
      v.body,
      /Reviewing abcdef1 failed\. \[Run log\]\(https:\/\/github.com\/Kong\/volcano-hosting\/actions\/runs\/9\)/u,
    );
    assert.match(
      v.body,
      /or have a collaborator with write access other than the author approve abcdef1, which stands in for the review\.$/u,
    );
    assert.equal(v.description, 'Review did not complete. Re-run it, or have a writer approve this commit.');
    assert.doesNotMatch(v.body, /P[0-3]|override/u);
  }
});

test('P3 and pre-existing findings leave the verdict passing', () => {
  const clean = claude(
    'success',
    output([finding('p3'), finding('p3'), finding('pre_existing', { line: 0, path: 'docs/a.md' })]),
  );
  assert.equal(clean.state, 'success');
  assert.equal(clean.description, 'No P0-P2 findings (2 P3, 1 pre-existing).');
  assert.match(clean.body, /^<!-- ai-review-verdict -->\n### AI review: no P0-P2 findings/u);
  assert.match(clean.body, /\*\*⚪ P3\*\*\n- `internal\/a.go:12` Nil map write\n- /u);
  assert.match(clean.body, /\*\*🟣 Pre-existing\*\*\n- `docs\/a.md` Nil map write/u);
  assert.doesNotMatch(clean.body, /P[012]\*\*|ai-review-override/u);

  const none = claude('success', output([]));
  assert.equal(none.state, 'success');
  assert.equal(none.description, 'No P0-P2 findings (0 P3, 0 pre-existing).');
  assert.doesNotMatch(none.body, /\*\*[🔴🟠🟡⚪🟣]/u);
  for (const v of [clean, none]) assert.ok(v.description.length <= 140, v.description);
});

test('P0, P1, and P2 findings fail the verdict', () => {
  for (const level of ['p0', 'p1', 'p2']) {
    const v = claude('success', output([finding('p3'), finding(level)]));
    assert.equal(v.state, 'failure', level);
    assert.equal(v.description, '1 P0-P2 finding(s). See the AI review comment.', level);
  }

  const failing = claude(
    'success',
    output([
      finding('p3', { line: 0, path: 'docs/a.md' }),
      finding('pre_existing'),
      finding('p2'),
      finding('p1'),
      finding('p0'),
    ]),
  );
  assert.equal(failing.state, 'failure');
  assert.equal(failing.description, '3 P0-P2 finding(s). See the AI review comment.');
  assert.match(failing.body, /### AI review: 3 P0-P2 finding\(s\)/u);
  assert.match(failing.body, /\*\*🔴 P0\*\*\n- `internal\/a.go:12` Nil map write/u);
  assert.match(failing.body, /\*\*⚪ P3\*\*\n- `docs\/a.md` Nil map write/u);
  assert.match(
    failing.body,
    /Reviewed abcdef1\. \[Run log\]\(https:\/\/github.com\/Kong\/volcano-hosting\/actions\/runs\/9\)/u,
  );
  assert.match(
    failing.body,
    /a collaborator with write access \(including the PR author\) add the `ai-review-override` label to accept abcdef1 as is/u,
  );
  // Sections run from most to least severe, whatever order Claude reported.
  assert.deepEqual(failing.body.match(/\*\*[🔴🟠🟡⚪🟣] [A-Za-z0-9-]+\*\*/gu), [
    '**🔴 P0**',
    '**🟠 P1**',
    '**🟡 P2**',
    '**⚪ P3**',
    '**🟣 Pre-existing**',
  ]);
  assert.ok(failing.description.length <= 140, failing.description);
});

test('a severity in another case or spelling still counts', () => {
  for (const severity of ['P1', ' p1', 'P1 ']) {
    const v = claude(
      'success',
      output([finding(severity), finding('Pre-existing'), finding('pre existing'), finding('P3')]),
    );
    assert.equal(v.state, 'failure', severity);
    assert.equal(v.description, '1 P0-P2 finding(s). See the AI review comment.');
    assert.match(v.body, /\*\*🟣 Pre-existing\*\*\n(- .*\n){1}- /u);
  }
});

test('finding text cannot ping people or escape its code span', () => {
  const v = claude('success', output([finding('p1', { path: 'a`b.go', title: 'cc @kong/everyone' })], 'Hi @someone'));
  assert.doesNotMatch(v.body, /@kong|@someone/u);
  assert.match(v.body, /@​kong\/everyone/u);
  assert.match(v.body, /- `a'b.go:12`/u);
});

test('the review decides whether a person must review, failing closed', () => {
  const reasonsFor = (human) => claude('success', output([finding('p3')], 'Adds a cache.', human)).reasons;
  assert.deepEqual(reasonsFor(routine), []);
  assert.deepEqual(reasonsFor({ needed: false, reasons: ['Ignored when not needed.'] }), []);
  assert.deepEqual(reasonsFor({ needed: true, reasons: [' Changes billing. ', '', 7, 'Adds a table.'] }), [
    'Changes billing.',
    'Adds a table.',
  ]);
  assert.deepEqual(reasonsFor({ needed: true, reasons: [] }), ['Claude asked for a human review.']);
  assert.equal(reasonsFor({ needed: true, reasons: Array.from({ length: 9 }, () => 'Reason.') }).length, 5);
  for (const human of [undefined, { needed: 'no', reasons: [] }, { reasons: [] }, 'no']) {
    assert.deepEqual(
      reasonsFor(human),
      ['Claude did not say whether this needs a human review.'],
      JSON.stringify(human),
    );
  }
  // The decision never changes the verdict on the findings.
  assert.equal(
    claude('success', output([], 'Adds a cache.', { needed: true, reasons: ['Changes billing.'] })).state,
    'success',
  );
  assert.deepEqual(claude('failure', '').reasons, ['No AI review completed.']);
});

test('globs match repository-relative paths', () => {
  for (const [glob, yes, no] of [
    [
      '.github/workflows/**',
      ['.github/workflows/ci.yml', '.github/workflows/a/b.yml'],
      ['github/workflows/ci.yml', '.github/workflows'],
    ],
    ['**/migrations/**', ['migrations/1.sql', 'db/migrations/1.sql'], ['db/migrations_old/1.sql', 'db/migrations']],
    ['**/CODEOWNERS', ['CODEOWNERS', '.github/CODEOWNERS'], ['CODEOWNERS.md', 'docs/NOT_CODEOWNERS']],
    ['infra/*.tf', ['infra/main.tf'], ['infra/prod/main.tf', 'infra/main.tfvars']],
    ['infra/**/prod/*.tf', ['infra/prod/a.tf', 'infra/aws/us/prod/a.tf'], ['infra/aws/prod/x/a.tf']],
    ['a?c.(x)', ['abc.(x)'], ['ac.(x)', 'a/c.(x)', 'abc.x']],
  ]) {
    for (const file of yes) assert.ok(globRegExp(glob).test(file), `${glob} ${file}`);
    for (const file of no) assert.ok(!globRegExp(glob).test(file), `${glob} ${file}`);
  }
});

test("the suggested reviewer is Claude's pick from the candidates, or the one with the most history", () => {
  const pick = (reviewer, reviewer_reason = 'wrote internal/billing', candidates = ['alice', 'bob']) =>
    claude(
      'success',
      output([], 'Adds a cache.', { needed: true, reasons: ['Changes billing.'], reviewer, reviewer_reason }),
      candidates,
    ).reviewer;
  assert.deepEqual(pick('bob'), { login: 'bob', why: 'wrote internal/billing' });
  assert.deepEqual(pick(' @Bob '), { login: 'bob', why: 'wrote internal/billing' });
  assert.deepEqual(pick('bob', ''), { login: 'bob', why: 'Claude suggested them' });
  for (const reviewer of ['mallory', '', undefined, 7]) {
    assert.deepEqual(
      pick(reviewer),
      { login: 'alice', why: 'most recent history in the changed files' },
      String(reviewer),
    );
  }
  assert.equal(pick('bob', 'why', []), null);
  assert.equal(claude('success', output([])).reviewer, null);
  assert.deepEqual(claude('failure', '', ['alice']).reviewer, {
    login: 'alice',
    why: 'most recent history in the changed files',
  });
});

test('the summary says what Claude could not check', () => {
  const body = (notChecked, findings = []) =>
    claude('success', JSON.stringify({ summary: 's', findings, human_review: routine, not_checked: notChecked })).body;
  const ran =
    "**Not checked:** Claude read the diff, the code, and the PR's text; it ran no tests or builds and read nothing outside this repository.";
  assert.ok(body().endsWith(`\n\n${ran}`));
  assert.ok(
    body([' Whether @kong/infra merged #63 first. ', '', 7]).endsWith(
      `\n\n${ran}\n- Whether @​kong/infra merged #63 first.`,
    ),
  );
  assert.equal(body(Array.from({ length: 9 }, () => 'Staging.')).split('\n- ').length - 1, 5);
  assert.match(
    body([], [finding('p1')]),
    new RegExp(`\\n\\n${ran.replaceAll(/[*.?()]/gu, '\\$&')}\\n\\nPush a fix`, 'u'),
  );
  assert.doesNotMatch(claude('failure', '').body, /Not checked/u);
  // The schema asks reviewers for the fields this action renders.
  const schema = JSON.parse(readRepo('.github/actions/ai-review/schema.json'));
  assert.ok(schema.required.includes('not_checked'));
  assert.equal(schema.properties.not_checked.items.type, 'string');
  assert.ok(schema.required.includes('reviewed_closely'));
  assert.equal(schema.properties.reviewed_closely.type, 'boolean');
});
