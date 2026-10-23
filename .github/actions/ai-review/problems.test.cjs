'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verdict } = require('./ai-review.cjs');
const { sha, url, finding, reviewJson } = require('./test-helpers.cjs');

// The verdict from a Claude and a Codex review, each given as its findings.
const both = (claude, codex) =>
  verdict(
    [
      { name: 'Claude', result: 'success', output: reviewJson({ findings: claude }) },
      { name: 'Codex', result: 'success', output: reviewJson({ findings: codex }) },
    ],
    sha,
    url,
  );
const listed = (v) => v.body.match(/^- `.*$/gmu);
const at = (path, line, severity, title) => finding(severity, { path, line, title });

// Shaped like two models' findings on one head of a real PR: seven P0-P2
// findings, where both models reported the same two problems a few lines apart
// in other words.
test('a problem two reviewers report nearby in one file counts once, with every line', () => {
  const proxy = 'internal/proxy/service.go';
  const store = 'internal/store/testing.go';
  const usage = 'internal/usage/jobs.go';
  const orders = 'internal/handlers/orders.go';
  const v = both(
    [
      at(proxy, 2446, 'p2', 'Cache fill skips the singleflight and timeout on the request path'),
      at(store, 32, 'p2', 'New //nolint directive suppresses a lint finding'),
      at(orders, 95, 'p3', 'Per-request nil check on dependencies that construction always sets'),
    ],
    [
      at(usage, 334, 'p2', 'Retry unknown usage before settling the order'),
      at(usage, 330, 'p2', 'Report overdue jobs instead of discarding them'),
      at(proxy, 2455, 'p2', 'Collapse concurrent cache misses'),
      at(orders, 48, 'p2', 'Move the new orchestration into a domain service'),
      at(store, 32, 'p2', 'Remove the newly introduced lint suppression'),
    ],
  );
  assert.equal(v.description, '5 P0-P2 finding(s). See the AI review comment.');
  assert.ok(v.body.includes('\n### AI review: 5 P0-P2 finding(s)\n'));
  // One reviewer's findings stay as it wrote them, however close.
  assert.deepEqual(listed(v), [
    `- \`${proxy}:2446,2455\` Cache fill skips the singleflight and timeout on the request path`,
    `- \`${store}:32\` New //nolint directive suppresses a lint finding`,
    `- \`${usage}:334\` Retry unknown usage before settling the order`,
    `- \`${usage}:330\` Report overdue jobs instead of discarding them`,
    `- \`${orders}:48\` Move the new orchestration into a domain service`,
    `- \`${orders}:95\` Per-request nil check on dependencies that construction always sets`,
  ]);
});

test('a problem takes the most severe level and title any reviewer gave it', () => {
  const v = both(
    [
      at(
        'internal/retention.go',
        41,
        'p3',
        'Retention retries a failing removal forever with no attempt cap or terminal record',
      ),
    ],
    [at('internal/retention.go', 48, 'p2', 'Cap retention retries and persist terminal failures')],
  );
  assert.equal(v.state, 'failure');
  assert.equal(v.description, '1 P0-P2 finding(s). See the AI review comment.');
  assert.deepEqual(listed(v), ['- `internal/retention.go:41,48` Cap retention retries and persist terminal failures']);
  assert.doesNotMatch(v.body, /P3/u);
});

test('nearly the same title is one problem in any file', () => {
  const v = both(
    [at('internal/handlers/exports.go', 104, 'p2', 'Exports are checked against the monthly quota but never counted')],
    [
      at('internal/jobs/export.go', 300, 'p2', 'Exports never consume the monthly quota'),
      at('docs/a.md', 0, 'p3', 'Typo'),
    ],
  );
  assert.deepEqual(listed(v), [
    '- `internal/handlers/exports.go:104`, `internal/jobs/export.go:300` Exports are checked against the monthly quota but never counted',
    '- `docs/a.md` Typo',
  ]);
  // A whole-file finding matches by title alone, and keeps its path.
  const file = both(
    [at('docs/a.md', 0, 'p3', 'Typo in the setup guide.')],
    [at('docs/a.md', 7, 'p3', 'typo in the  Setup guide')],
  );
  assert.deepEqual(listed(file), ['- `docs/a.md:7` Typo in the setup guide.']);
});

test('different problems stay apart', () => {
  const cases = [
    // Far apart in one file, under different titles.
    [at('internal/a.go', 10, 'p2', 'Nil map write')],
    [at('internal/a.go', 31, 'p2', 'Unchecked error')],
    // Titles that share a word or two but name different problems.
    [at('internal/releases.go', 298, 'p2', 'Refresh the proxy cache after a release')],
    [at('internal/proxy.go', 2879, 'p2', 'Log proxy cache errors at warn level')],
    // Nearby in different files.
    [at('internal/a.go', 12, 'p1', 'Nil map write')],
    [at('internal/b.go', 12, 'p1', 'Unchecked error')],
  ];
  for (let i = 0; i < cases.length; i += 2) {
    const v = both(cases[i], cases[i + 1]);
    assert.equal(listed(v).length, 2, JSON.stringify(cases.slice(i, i + 2)));
  }
});

test('a problem holds at most one finding from each reviewer', () => {
  // Codex's finding sits between two of Claude's; it joins the first, and
  // Claude's two stay apart.
  const v = both(
    [at('internal/a.go', 10, 'p1', 'Nil map write'), at('internal/a.go', 25, 'p1', 'Unchecked error')],
    [at('internal/a.go', 15, 'p1', 'Map written before make')],
  );
  assert.deepEqual(listed(v), ['- `internal/a.go:10,15` Nil map write', '- `internal/a.go:25` Unchecked error']);
});
