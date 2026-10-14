'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, marker, publish } = require('./claude-review.cjs');
const { sha, url, finding, output, clearAfter, client, context, core } = require('./test-helpers.cjs');

test('publish creates the summary comment once and then edits it', async (t) => {
  clearAfter(t, 'REVIEW_RESULT', 'FINDINGS');
  process.env.REVIEW_RESULT = 'success';
  process.env.FINDINGS = output([finding('p1')]);

  const fresh = client({ comments: [{ id: 1, user: { login: 'someone' }, body: marker }] });
  await publish({ github: fresh.github, context: context(), core: core() });
  assert.equal(fresh.named('createComment').length, 1);
  assert.equal(fresh.named('updateComment').length, 0);
  assert.equal(fresh.named('createCommitStatus')[0].state, 'failure');
  assert.equal(fresh.named('createCommitStatus')[0].target_url, url);

  const existing = client({ comments: [{ id: 2, user: { login: 'github-actions[bot]' }, body: `${marker}\nold` }] });
  await publish({ github: existing.github, context: context(), core: core() });
  assert.equal(existing.named('createComment').length, 0);
  assert.deepEqual(
    existing.named('updateComment').map((c) => c.comment_id),
    [2],
  );
});

test('publish leaves the summary to the live head when this SHA is stale', async (t) => {
  clearAfter(t, 'REVIEW_RESULT', 'FINDINGS');
  process.env.REVIEW_RESULT = 'success';
  process.env.FINDINGS = output([finding('p1')]);
  const c = client({
    liveHead: 'fedcba9876543210',
    comments: [{ id: 2, user: { login: 'github-actions[bot]' }, body: marker }],
  });
  await publish({ github: c.github, context: context(), core: core() });
  assert.equal(c.named('createComment').length + c.named('updateComment').length, 0);
  assert.deepEqual(
    c.set(statusContext).map(([head, state]) => [head, state]),
    [[sha, 'failure']],
  );
  assert.deepEqual(
    c.set(humanStatusContext).map(([head, state]) => [head, state]),
    [[sha, 'pending']],
  );
});

test('a closed PR publishes unless another open PR has its head', async (t) => {
  clearAfter(t, 'REVIEW_RESULT', 'FINDINGS');
  process.env.REVIEW_RESULT = 'success';
  process.env.FINDINGS = output([finding('p1')]);
  const other = (number, state, head) => ({ number, state, head: { sha: head } });

  const taken = client({ state: 'closed', associated: [other(7, 'closed', sha), other(8, 'open', sha)] });
  await publish({ github: taken.github, context: context(), core: core() });
  assert.equal(taken.named('createCommitStatus').length + taken.named('createComment').length, 0);

  for (const associated of [
    [],
    [other(7, 'closed', sha)],
    [other(8, 'closed', sha)],
    [other(8, 'open', 'fedcba9876543210')],
  ]) {
    const alone = client({ state: 'closed', associated });
    await publish({ github: alone.github, context: context(), core: core() });
    assert.deepEqual(
      alone.set(statusContext).map(([, state]) => state),
      ['failure'],
      JSON.stringify(associated),
    );
  }

  const open = client({ associated: [other(8, 'open', sha)] });
  await publish({ github: open.github, context: context(), core: core() });
  assert.deepEqual(
    open.set(statusContext).map(([, state]) => state),
    ['failure'],
  );
  assert.equal(open.named('listPullRequestsAssociatedWithCommit').length, 0);
});

test('publish sets the status even when the summary comment fails', async (t) => {
  clearAfter(t, 'REVIEW_RESULT', 'FINDINGS');
  process.env.REVIEW_RESULT = 'success';
  process.env.FINDINGS = output([finding('p1')]);
  const c = client({ failComments: true });
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  assert.deepEqual(
    c.named('createCommitStatus').map((s) => [s.context, s.state]),
    [
      [statusContext, 'failure'],
      [humanStatusContext, 'pending'],
    ],
  );
  assert.equal(k.failures.length, 1);
  assert.match(k.failures[0], /verdict is published, but the summary comment failed/u);
});

test('publish reports an incomplete review as an error, says so in the summary, and fails the job', async (t) => {
  clearAfter(t, 'REVIEW_RESULT', 'FINDINGS');
  process.env.REVIEW_RESULT = 'failure';
  delete process.env.FINDINGS;
  const c = client({
    comments: [
      { id: 2, user: { login: 'github-actions[bot]' }, body: `${marker}\n### Claude review: no P0-P2 findings` },
    ],
  });
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  assert.equal(c.named('createComment').length, 0);
  assert.deepEqual(
    c.named('updateComment').map((u) => u.comment_id),
    [2],
  );
  assert.match(c.named('updateComment')[0].body, /### Claude review: did not complete/u);
  assert.equal(c.named('createCommitStatus')[0].state, 'error');
  assert.equal(k.failures.length, 1);
});
