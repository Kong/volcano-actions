'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, humanLabel, start, gate } = require('./ai-review.cjs');
const { sha, review, clearAfter, client, context, core } = require('./test-helpers.cjs');

// Volcano's Apps, as the workflow passes them.
const apps = 'volcano-github-app[bot],volcano-staging[bot]';
const staging = { login: 'volcano-staging[bot]', type: 'Bot' };
const older = '1234567890abcdef';
// A COMMENT review, as LavaFlow posts its own, by `user` of `commit`.
const posted = (user = staging, commit = sha, id = 41) => ({
  id,
  user,
  state: 'COMMENTED',
  commit_id: commit,
  html_url: `https://github.com/Kong/volcano-hosting/pull/7#pullrequestreview-${id}`,
});
const verdict = (state, description = 'x') => ({ context: statusContext, state, description });

// A client whose live PR was opened by `author`.
function openedBy(author, options = {}) {
  const c = client(options);
  const { get } = c.github.rest.pulls;
  c.github.rest.pulls.get = async (args) => {
    const { data } = await get(args);
    return { data: { ...data, user: author } };
  };
  return c;
}

// Runs start for a PR `author` opened, with LAVAFLOW_APPS set to `list`.
async function startFor(t, author, options = {}, list = apps) {
  clearAfter(t, 'LAVAFLOW_APPS');
  process.env.LAVAFLOW_APPS = list;
  const c = openedBy(author, options);
  const k = core();
  await start({ github: c.github, context: context({ actor: author.login, action: 'opened' }), core: k });
  return { c, k };
}

const reviewed = (c) => c.named('createCommitStatus').map((s) => [s.context, s.state, s.description, s.target_url]);
const asUsual = [
  [statusContext, 'pending', 'The AI review is running.'],
  [humanStatusContext, 'pending', 'Waiting for the AI review.'],
];
const ranAsUsual = (c, k, message) => {
  assert.deepEqual(k.outputs, { review: 'true' }, message);
  assert.deepEqual(
    reviewed(c).map((s) => s.slice(0, 3)),
    asUsual,
    message,
  );
};

test("an App's PR skips the review at a head the same App reviewed, and waits for a person", async (t) => {
  for (const user of [staging, { login: 'volcano-github-app[bot]', type: 'Bot' }]) {
    const { c, k } = await startFor(t, user, { reviews: [posted(user, older, 40), posted(user)] });
    assert.deepEqual(k.outputs, { review: 'false' }, user.login);
    // The human status goes first, and never passes on the skip alone.
    assert.deepEqual(
      reviewed(c),
      [
        [
          humanStatusContext,
          'pending',
          'Needs human review: LavaFlow reviewed abcdef1 in place of the AI review.',
          'https://github.com/Kong/volcano-hosting/actions/runs/9',
        ],
        [
          statusContext,
          'success',
          'Skipped: LavaFlow reviewed abcdef1 (review 41).',
          'https://github.com/Kong/volcano-hosting/pull/7#pullrequestreview-41',
        ],
      ],
      user.login,
    );
    assert.deepEqual(
      c.named('listReviews').map((l) => [l.pull_number, l.per_page]),
      [
        [7, 100],
        [7, 100],
      ],
    );
    assert.ok(
      k.notices.includes(`Skipping the review of abcdef1: ${user.login} opened the PR and reviewed it (review 41).`),
    );
  }
});

test('only an approval by a person with write access passes the human status of a skipped head', async (t) => {
  const state = async (reviews, labels = []) => {
    const { c } = await startFor(t, staging, { reviews: [posted(), ...reviews], labels });
    return c.set(humanStatusContext).map(([, s, description]) => [s, description]);
  };
  const waiting = [['pending', 'Needs human review: LavaFlow reviewed abcdef1 in place of the AI review.']];
  // The App's own review, the author, and other bots are not a person's approval.
  assert.deepEqual(await state([]), waiting);
  assert.deepEqual(await state([review('volcano-staging[bot]', 'APPROVED', 'Bot')]), waiting);
  assert.deepEqual(await state([review('copilot', 'APPROVED', 'Bot')]), waiting);
  assert.deepEqual(await state([review('reviewer', 'COMMENTED')]), waiting);
  assert.deepEqual(await state([review('reviewer', 'APPROVED')]), [['success', 'Approved by reviewer.']]);
  assert.deepEqual(await state([review('reviewer', 'APPROVED'), review('other', 'CHANGES_REQUESTED')]), [
    ['pending', 'Changes requested by other.'],
  ]);
  // The label still asks for a person too.
  assert.deepEqual(await state([], [{ name: humanLabel }]), waiting);
});

test("an App's head with no review of its own runs the review as usual", async (t) => {
  for (const [name, reviews] of [
    ['no review', []],
    ['a review of an older head', [posted(staging, older)]],
    ['a review by the other App', [posted({ login: 'volcano-github-app[bot]', type: 'Bot' })]],
    ['a review by a person', [posted({ login: 'reviewer', type: 'User' })]],
    ['an account named like the App that is not a bot', [posted({ login: 'volcano-staging[bot]', type: 'User' })]],
    ['an approval rather than a comment review', [{ ...posted(), state: 'APPROVED' }]],
    ['a dismissed review', [{ ...posted(), state: 'DISMISSED' }]],
  ]) {
    const { c, k } = await startFor(t, staging, { reviews });
    ranAsUsual(c, k, name);
  }
});

test('a PR a person or another bot opened runs the review as usual, without reading its reviews', async (t) => {
  for (const [author, list] of [
    [{ login: 'author', type: 'User' }, apps],
    // A User-typed account with the App's name.
    [{ login: 'volcano-staging[bot]', type: 'User' }, apps],
    // Lookalikes match no login exactly.
    [{ login: 'volcano-foo[bot]', type: 'Bot' }, apps],
    [{ login: 'volcano-staging-preview[bot]', type: 'Bot' }, apps],
    [{ login: 'Volcano-Staging[bot]', type: 'Bot' }, apps],
    [{ login: 'volcano-staging', type: 'Bot' }, apps],
    [{ login: 'dependabot[bot]', type: 'Bot' }, apps],
    // No list skips nothing.
    [staging, ''],
    [staging, 'volcano-github-app[bot]'],
  ]) {
    const { c, k } = await startFor(t, author, { reviews: [posted(author)] }, list);
    ranAsUsual(c, k, `${author.login} ${author.type} [${list}]`);
    assert.deepEqual(c.named('listReviews'), [], author.login);
  }
});

test('the list reads commas and newlines', async (t) => {
  const { k } = await startFor(t, staging, { reviews: [posted()] }, 'volcano-github-app[bot]\n volcano-staging[bot]\n');
  assert.deepEqual(k.outputs, { review: 'false' });
});

// A re-run, a retarget, or a draft round trip of a head the AI review already
// judged reviews it again; it never swaps that verdict for LavaFlow's.
test("LavaFlow's review never replaces the AI review's verdict for its head", async (t) => {
  for (const status of [verdict('failure'), verdict('error'), verdict('success', 'No P0-P2 findings.')]) {
    const { c, k } = await startFor(t, staging, { reviews: [posted()], statuses: [status] });
    ranAsUsual(c, k, status.state);
  }
  for (const status of [verdict('pending'), verdict('success', 'Skipped: LavaFlow reviewed abcdef1 (review 40).')]) {
    const { k } = await startFor(t, staging, { reviews: [posted()], statuses: [status] });
    assert.deepEqual(k.outputs, { review: 'false' }, status.description);
  }
});

test("an error reading the PR's reviews or statuses runs the review as usual", async (t) => {
  for (const options of [{ failReviews: true }, { failStatuses: true }]) {
    const { c, k } = await startFor(t, staging, { reviews: [posted()], ...options });
    ranAsUsual(c, k, JSON.stringify(options));
    assert.ok(
      k.warnings.some((w) => w.startsWith("Could not pass abcdef1 on LavaFlow's review, so the AI review runs: ")),
      JSON.stringify(k.warnings),
    );
  }
  // A failed status write after the human status runs it as usual too.
  clearAfter(t, 'LAVAFLOW_APPS');
  process.env.LAVAFLOW_APPS = apps;
  const c = openedBy(staging, { reviews: [posted()] });
  const write = c.github.rest.repos.createCommitStatus;
  c.github.rest.repos.createCommitStatus = (args) =>
    args.state === 'success' ? Promise.reject(Object.assign(new Error('Server Error'), { status: 500 })) : write(args);
  const k = core();
  await start({ github: c.github, context: context({ actor: staging.login }), core: k });
  assert.deepEqual(k.outputs, { review: 'true' });
  assert.deepEqual(c.set(statusContext).at(-1), [sha, 'pending', 'The AI review is running.']);
});

// The human gate re-sets a skipped head on later reviews, though no summary
// comment records a decision for it.
test("the human gate re-sets a head passed on LavaFlow's review", async () => {
  const skipped = verdict('success', 'Skipped: LavaFlow reviewed abcdef1 (review 41).');
  const run = async (reviews, statuses = [skipped]) => {
    const c = client({ reviews, statuses });
    await gate({ github: c.github, context: context({ action: 'labeled' }), core: core() });
    return c.set(humanStatusContext).map(([, s, description]) => [s, description]);
  };
  assert.deepEqual(await run([posted()]), [
    ['pending', 'Needs human review: LavaFlow reviewed abcdef1 in place of the AI review.'],
  ]);
  assert.deepEqual(await run([posted(), review('reviewer', 'APPROVED')]), [['success', 'Approved by reviewer.']]);
  // A head under review still waits for it.
  assert.deepEqual(await run([review('reviewer', 'APPROVED')], [verdict('pending')]), []);
  assert.deepEqual(await run([review('reviewer', 'APPROVED')], [verdict('failure', skipped.description)]), []);
});
