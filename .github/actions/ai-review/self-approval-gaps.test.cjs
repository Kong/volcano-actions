'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, gate } = require('./ai-review.cjs');
const { selfApproverOf } = require('./self-approval.cjs');
const { sha, review, context, core } = require('./test-helpers.cjs');
const {
  client,
  passing,
  selfApproval,
  useSelfApprovers,
  publishFor,
  decidedWithin,
} = require('./self-approval-fakes.cjs');

test('publish records the decision before the verdict passes', async (t) => {
  useSelfApprovers(t);
  const { c } = await publishFor(t);
  const order = c.calls
    .filter((call) => ['createComment', 'createCommitStatus', 'createReview'].includes(call.call))
    .map((call) => (call.context ? `${call.context} ${call.state}` : call.call));
  assert.deepEqual(order.slice(0, 2), ['createComment', `${statusContext} success`]);
  assert.equal(order.at(-1), 'createReview');
});

test('publish gives no approval when the summary that records its decision fails', async (t) => {
  useSelfApprovers(t);
  const { c, k } = await publishFor(t, { failComments: true });
  assert.deepEqual(c.named('createReview'), []);
  assert.match(k.failures.join('\n'), /summary comment failed/u);
  // The verdict and the human status are still set.
  assert.deepEqual(c.set(statusContext)[0].slice(1, 2), ['success']);
  assert.deepEqual(c.set(humanStatusContext), [[sha, 'success', 'No human review needed.']]);
});

test('gate withdraws an approval no recorded decision stands behind', async (t) => {
  useSelfApprovers(t);
  const c = client({ author: 'octocat', statuses: passing, reviews: [selfApproval()] });
  await gate({ github: c.github, context: context({ action: 'labeled', author: 'octocat' }), core: core() });
  assert.deepEqual(
    c.named('dismissReview').map((d) => d.review_id),
    [31],
  );
  assert.deepEqual(c.set(humanStatusContext), []);
});

test('gate withdraws the approval when it cannot re-set the human status, and fails the verdict if that fails too', async (t) => {
  useSelfApprovers(t);
  // The human status cannot be set, but the approval can still be withdrawn.
  // (Reading a person's access fails.)
  const withdrawable = client({
    author: 'octocat',
    statuses: passing,
    comments: [decidedWithin()],
    // A person's review, whose access cannot be read.
    reviews: [selfApproval(), review('reviewer', 'APPROVED')],
  });
  withdrawable.github.rest.repos.getCollaboratorPermissionLevel = () => Promise.reject(new Error('Server Error'));
  const k = core();
  await gate({ github: withdrawable.github, context: context({ action: 'labeled', author: 'octocat' }), core: k });
  assert.match(k.failures.join('\n'), /Could not re-set the human review status of #7/u);
  assert.equal(withdrawable.named('dismissReview').length, 1);
  assert.deepEqual(withdrawable.set(statusContext), []);

  // Nothing can be read: the verdict fails rather than leave an approval usable.
  const stuck = client({ author: 'octocat', statuses: passing, comments: [decidedWithin()], failReviews: true });
  await gate({ github: stuck.github, context: context({ action: 'labeled', author: 'octocat' }), core: core() });
  assert.deepEqual(stuck.set(statusContext), [
    [sha, 'failure', "Could not withdraw the AI review's approval. Re-run the review."],
  ]);
});

test("without self-approvers, gate's read failures leave the verdict alone", async () => {
  const c = client({ statuses: passing, comments: [decidedWithin()], failReviews: true });
  const k = core();
  await gate({ github: c.github, context: context({ action: 'labeled' }), core: k });
  assert.equal(k.failures.length, 1);
  assert.deepEqual(c.set(statusContext), []);
});

test('a `*` line names the reviewer for authors without their own, and a flagged scope may continue on the next line', (t) => {
  useSelfApprovers(
    t,
    [
      '*, reviewed by monalisa, behind a feature flag:',
      '  a feature behind a flag',
      'hubot, reviewed by octocat: copy',
    ].join('\n'),
  );
  assert.deepEqual(selfApproverOf({ login: 'someone', type: 'User' }), {
    scopes: ['a feature behind a flag'],
    flagged: ['a feature behind a flag'],
    reviewer: 'monalisa',
  });
  assert.equal(selfApproverOf({ login: 'hubot', type: 'User' }).reviewer, 'octocat');
  // A flagged line that never gets a scope names nobody.
  useSelfApprovers(t, '*, behind a feature flag:\nhubot: copy');
  assert.equal(selfApproverOf({ login: 'someone', type: 'User' }), null);
  assert.deepEqual(selfApproverOf({ login: 'hubot', type: 'User' }).scopes, ['copy']);
});
