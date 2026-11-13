'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, marker, publish, handoff } = require('./ai-review.cjs');
const { decisionMarker } = require('./decision.cjs');
const { sha, finding, reviewJson, claudeReviews, clearAfter, client, context, core } = require('./test-helpers.cjs');

const opened = '2026-10-23T10:00:00Z';
const otherHead = 'fedcba9876543210';
const failed = [{ context: statusContext, state: 'failure', description: '1 P0-P2 finding(s).' }];

// The summary comment as publish leaves it, recording its rounds.
const summary = (rounds, head = sha) => ({
  id: 2,
  user: { login: 'github-actions[bot]' },
  body: `${marker}\n### AI review: 1 P0-P2 finding(s)\n\n${decisionMarker(head, { reasons: [], reviewer: null, rounds })}`,
});
const isHandOff = (w) => w.body.startsWith('<!-- ai-review-rounds -->');

// Publishes a failing round as a caller with a handoff job configures it.
async function publishForJob(t, stored) {
  process.env.HAND_OFF = 'job';
  clearAfter(t, 'HAND_OFF');
  claudeReviews(t, 'success', reviewJson({ findings: [finding('p1')] }));
  const c = client({ statuses: failed, comments: [summary(stored, otherHead)] });
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  return { c, k };
}

async function runHandoff(options) {
  const c = client({ statuses: failed, ...options });
  const k = core();
  await handoff({ github: c.github, context: context(), core: k });
  return { c, k, handOff: c.named('createComment').find((w) => isHandOff(w)), drafted: c.named('graphql') };
}

test('with a handoff job, publish leaves the third failing round to it', async (t) => {
  const { c, k } = await publishForJob(t, { since: opened, count: 2, sha: otherHead });
  assert.equal(k.outputs['hand-off'], 'true');
  assert.deepEqual(c.named('graphql'), []);
  assert.equal(c.named('createComment').find((w) => isHandOff(w)), undefined);
});

test('with a handoff job, publish asks for none before the limit', async (t) => {
  const { k } = await publishForJob(t, { since: opened, count: 1, sha: otherHead });
  assert.equal(k.outputs['hand-off'], undefined);
});

test('the handoff step moves the PR to draft and asks the author to re-assess', async () => {
  const { k, handOff, drafted } = await runHandoff({ comments: [summary({ since: opened, count: 3, sha })] });
  assert.deepEqual(
    drafted.map((d) => d.id),
    ['PR_7'],
  );
  assert.match(drafted[0].query, /convertPullRequestToDraft/u);
  assert.match(handOff.body, /so the AI review moved this PR back to draft, where it reviews no pushes/u);
  assert.deepEqual(k.failures, []);
});

test('the handoff step fails, naming the permission, when its token cannot convert the PR', async () => {
  const { k, handOff } = await runHandoff({ comments: [summary({ since: opened, count: 3, sha })], failDraft: true });
  assert.match(handOff.body, /could not move this PR back to draft, so it keeps reviewing each push/u);
  assert.equal(k.failures.length, 1);
  assert.match(
    k.failures[0],
    /^Could not move the PR back to draft after 3 failing rounds\. Converting a PR to draft takes a GITHUB_TOKEN with contents: write and pull-requests: write/u,
  );
});

test('the handoff step hands off only a head whose summary records the limit', async () => {
  for (const comments of [
    [],
    [summary({ since: opened, count: 2, sha })],
    [summary({ since: opened, count: 3, sha: otherHead }, otherHead)],
  ]) {
    const { k, handOff, drafted } = await runHandoff({ comments });
    assert.equal(handOff, undefined);
    assert.deepEqual(drafted, []);
    assert.deepEqual(k.failures, []);
  }
});

test('the handoff step leaves a PR that is no longer ready and failing', async () => {
  const comments = [summary({ since: opened, count: 3, sha })];
  for (const options of [{ draft: true }, { state: 'closed' }, { liveHead: otherHead }, { statuses: [] }]) {
    const { k, handOff, drafted } = await runHandoff({ comments, ...options });
    assert.equal(handOff, undefined, JSON.stringify(options));
    assert.deepEqual(drafted, [], JSON.stringify(options));
    assert.deepEqual(k.failures, [], JSON.stringify(options));
  }
});
