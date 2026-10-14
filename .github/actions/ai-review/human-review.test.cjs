'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { humanStatusContext, humanLabel, publish } = require('./ai-review.cjs');
const {
  sha,
  finding,
  output,
  routine,
  review,
  claudeReviews,
  clearAfter,
  client,
  context,
  core,
} = require('./test-helpers.cjs');

// Publishes a clean review with this human decision.
async function publishHuman(human, options = {}) {
  process.env.REVIEWS = claudeReviews('success', output([], 'Adds a cache.', human));
  const c = client(options);
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  assert.deepEqual(k.failures, []);
  return { human: c.set(humanStatusContext), body: c.named('createComment')[0].body };
}

test('publish passes the human status only when nothing calls for a person', async (t) => {
  clearAfter(t, 'REVIEWS');
  const quiet = await publishHuman(routine);
  assert.deepEqual(quiet.human, [[sha, 'success', 'No human review needed.']]);
  assert.match(quiet.body, /\n\n\*\*Human review:\*\* not needed\n\n<!-- ai-review-human [A-Za-z0-9+/=]+ -->$/u);

  const billing = await publishHuman({ needed: true, reasons: ['Changes how @kong/billing rounds invoices.'] });
  assert.deepEqual(billing.human, [[sha, 'pending', 'Needs human review: Changes how @kong/billing rounds invoices.']]);
  assert.match(billing.body, /\*\*Human review:\*\* needed\n- Changes how @​kong\/billing rounds invoices\.\n/u);

  // The label asks live, so the comment does not record it.
  const labeled = await publishHuman(routine, { labels: [{ name: humanLabel }] });
  assert.deepEqual(labeled.human, [[sha, 'pending', `Needs human review: The ${humanLabel} label asks for one.`]]);
  assert.match(labeled.body, /\*\*Human review:\*\* not needed/u);

  const long = await publishHuman({ needed: true, reasons: ['x'.repeat(300)] });
  assert.equal(long.human[0][2].length, 140);
  assert.ok(long.human[0][2].endsWith('…'));
});

test('CI and reviewer instruction files need no person by themselves', async (t) => {
  clearAfter(t, 'REVIEWS');
  // No kind of file needs a person by itself; reviewers judge CI and reviewer
  // instructions like any other change, and nothing lists the files.
  const ci = await publishHuman(routine, {
    files: [{ filename: '.github/workflows/ci.yml' }, { filename: 'api/AGENTS.md' }, { filename: 'CODEOWNERS' }],
    failFiles: true,
  });
  assert.deepEqual(ci.human, [[sha, 'success', 'No human review needed.']]);
});

test("a repository's reserved paths need a person", async (t) => {
  clearAfter(t, 'REVIEWS', 'HUMAN_REVIEW_PATHS');
  // A repository's own paths decide without the reviewers, at a file's old or
  // new path.
  process.env.HUMAN_REVIEW_PATHS = '# Schema changes\n  **/migrations/**  \n\ninfra/*.tf\n';
  const moved = await publishHuman(routine, {
    files: [{ filename: 'db/old/1.sql', previous_filename: 'db/migrations/1.sql' }],
  });
  assert.deepEqual(moved.human, [
    [
      sha,
      'pending',
      'Needs human review: Changes a path this repository reserves for human review: db/migrations/1.sql.',
    ],
  ]);
  const many = await publishHuman(routine, {
    files: [{ filename: 'infra/a.tf' }, { filename: 'main.go' }, { filename: 'infra/b.tf' }],
  });
  assert.deepEqual(many.human, [
    [
      sha,
      'pending',
      'Needs human review: Changes a path this repository reserves for human review: infra/a.tf (+1 more).',
    ],
  ]);
  const elsewhere = await publishHuman(routine, {
    files: [{ filename: '.github/workflows/ci.yml' }, { filename: 'infra/prod/main.tf' }],
  });
  assert.deepEqual(elsewhere.human, [[sha, 'success', 'No human review needed.']]);
  const capped = await publishHuman(routine, {
    files: Array.from({ length: 3000 }, (_, i) => ({ filename: `src/${i}.go` })),
  });
  assert.deepEqual(capped.human, [
    [sha, 'pending', 'Needs human review: Changes more files than GitHub lists, so not every path could be checked.'],
  ]);
  const unlisted = await publishHuman(routine, { failFiles: true });
  assert.deepEqual(unlisted.human, [
    [
      sha,
      'pending',
      'Needs human review: Could not list the changed files to check them for paths that need a human review.',
    ],
  ]);
});

test('publish records an incomplete review as needing a person', async (t) => {
  clearAfter(t, 'REVIEWS');
  process.env.REVIEWS = claudeReviews('failure');
  const c = client();
  await publish({ github: c.github, context: context(), core: core() });
  assert.deepEqual(c.set(humanStatusContext), [[sha, 'pending', 'Needs human review: No AI review completed.']]);
  assert.doesNotMatch(c.named('createComment')[0].body, /Human review:/u);
  assert.match(c.named('createComment')[0].body, /\n\n<!-- ai-review-human [A-Za-z0-9+/=]+ -->$/u);
});

test('a writer other than the author approves, and a change request holds the head', async (t) => {
  clearAfter(t, 'REVIEWS');
  const needed = { needed: true, reasons: ['Changes billing.'] };
  const waiting = 'Needs human review: Changes billing.';
  for (const [human, options, want] of [
    [needed, { reviews: [review('reviewer', 'APPROVED')] }, ['success', 'Approved by reviewer.']],
    [
      needed,
      { reviews: [review('reviewer', 'APPROVED'), review('reviewer', 'COMMENTED')] },
      ['success', 'Approved by reviewer.'],
    ],
    [needed, { reviews: [review('reviewer', 'COMMENTED')] }, ['pending', waiting]],
    [needed, { reviews: [review('reviewer', 'APPROVED'), review('reviewer', 'DISMISSED')] }, ['pending', waiting]],
    [needed, { reviews: [review('reader', 'APPROVED')], permissions: { reader: 'read' } }, ['pending', waiting]],
    [needed, { reviews: [review('gone', 'APPROVED')], permissions: { gone: null } }, ['pending', waiting]],
    [needed, { reviews: [review('copilot', 'APPROVED', 'Bot')] }, ['pending', waiting]],
    [needed, { reviews: [review('author', 'APPROVED')] }, ['pending', waiting]],
    [needed, { reviews: [review('a', 'APPROVED'), review('b', 'APPROVED')] }, ['success', 'Approved by a, b.']],
    [routine, { reviews: [review('reviewer', 'CHANGES_REQUESTED')] }, ['pending', 'Changes requested by reviewer.']],
    [
      routine,
      { reviews: [review('reader', 'CHANGES_REQUESTED')], permissions: { reader: 'read' } },
      ['success', 'No human review needed.'],
    ],
    [
      routine,
      { reviews: [review('reviewer', 'CHANGES_REQUESTED'), review('reviewer', 'APPROVED')] },
      ['success', 'Approved by reviewer.'],
    ],
    [
      needed,
      { reviews: [review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')] },
      ['pending', 'Changes requested by b.'],
    ],
  ]) {
    process.env.REVIEWS = claudeReviews('success', output([], 'Adds a cache.', human));
    const c = client(options);
    await publish({ github: c.github, context: context(), core: core() });
    assert.deepEqual(c.set(humanStatusContext), [[sha, ...want]], JSON.stringify(options.reviews));
  }
});

const question = { needed: true, reasons: ['Should the task role write every queue?'] };
const ask = 'Decide the points above: approve to accept them, or request changes.';

// Publishes a review that asks a person this question; returns the summary.
async function publishQuestion({ findings = [finding('p3')], human = question, closely = true, options = {} } = {}) {
  process.env.REVIEWS = claudeReviews(
    'success',
    JSON.stringify({
      summary: 'Adds a cache.',
      findings,
      human_review: human,
      not_checked: [],
      reviewed_closely: closely,
    }),
  );
  const c = client(options);
  await publish({ github: c.github, context: context(), core: core() });
  return c.named('createComment')[0].body;
}

// Reviewers' tools read the decision from the marker rather than the prose.
const marked = (body) =>
  JSON.parse(Buffer.from(body.match(/\n<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u)[1], 'base64').toString('utf8'))
    .cleared;

test('a person is asked to decide the reasons, not to review the code again', async (t) => {
  clearAfter(t, 'REVIEWS');
  const cleared = await publishQuestion();
  assert.ok(
    cleared.includes(
      `\n- Should the task role write every queue?\n\nClaude found no P0-P2 problems at abcdef1, so the code needs no second review for bugs. ${ask}\n\n`,
    ),
  );
  assert.equal(marked(cleared), true);
  assert.doesNotMatch(await publishQuestion({ human: routine }), /Decide the points/u);
});

test('nothing says the code is done when the review cannot vouch for it', async (t) => {
  clearAfter(t, 'REVIEWS', 'HUMAN_REVIEW_PATHS');
  // Nothing says the code is done when findings block, when the review could
  // not read it closely or did not say, when it gave no reason of its own, or
  // when the path is reserved for a person.
  for (const [why, args] of [
    ['blocking finding', { findings: [finding('p1')] }],
    ['not read closely', { closely: false }],
    ['closeness unsaid', { closely: null }],
    ['closeness malformed', { closely: 'yes' }],
    ['no own reason', { human: { needed: true, reasons: [] } }],
    ['labeled for a person', { options: { labels: [{ name: humanLabel }] } }],
    ['live reasons unread', { options: { failStatuses: true } }],
  ]) {
    const body = await publishQuestion(args);
    assert.match(body, new RegExp(`\\n\\n${ask}\\n\\n`, 'u'), why);
    assert.doesNotMatch(body, /no second review/u, why);
    assert.equal(marked(body), false, why);
  }
  process.env.HUMAN_REVIEW_PATHS = '**/migrations/**';
  const reserved = await publishQuestion({ options: { files: [{ filename: 'db/migrations/1.sql' }] } });
  assert.match(reserved, /- Changes a path this repository reserves for human review: db\/migrations\/1\.sql\.\n/u);
  assert.doesNotMatch(reserved, /no second review/u);
});
