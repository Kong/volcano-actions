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

test('publish neither approves nor passes the verdict when the summary that records its decision fails', async (t) => {
  useSelfApprovers(t);
  const { c, k } = await publishFor(t, { failComments: true });
  assert.deepEqual(c.named('createReview'), []);
  assert.match(k.failures.join('\n'), /summary comment failed/u);
  // Later events would read an earlier decision, so the verdict fails; the
  // human status is still set.
  assert.deepEqual(c.set(statusContext), [
    [sha, 'failure', "The summary does not record this review's decision. Re-run the review."],
  ]);
  assert.deepEqual(c.set(humanStatusContext), [[sha, 'success', 'No human review needed.']]);
  // Without self-approvers, the verdict stands as before.
  process.env.SELF_APPROVERS = '';
  const plain = await publishFor(t, { failComments: true, author: 'someone' });
  assert.equal(plain.c.set(statusContext)[0][1], 'success');
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

test('gate acts again when a review records a new decision for the head while it runs', async (t) => {
  useSelfApprovers(t);
  const now = {
    ...decidedWithin(),
    body: decidedWithin().body.replace(/<!-- ai-review-human (\S+) -->$/u, (_, encoded) => {
      const decision = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const updated = { ...decision, reasons: ['Changes the layout.'] };
      return `<!-- ai-review-human ${Buffer.from(JSON.stringify(updated)).toString('base64')} -->`;
    }),
  };
  const c = client({ author: 'octocat', statuses: passing });
  // The first read finds the old decision; publish replaces it after that.
  const reads = [[decidedWithin()]];
  const { paginate } = c.github;
  c.github.paginate = (method, args) =>
    method === c.github.rest.issues.listComments ? Promise.resolve(reads.shift() ?? [now]) : paginate(method, args);
  await gate({ github: c.github, context: context({ action: 'labeled', author: 'octocat' }), core: core() });
  // It approved from the old decision, then withdrew on the new one.
  assert.equal(c.named('createReview').length, 1);
  assert.equal(c.named('dismissReview').length, 1);
  assert.deepEqual(c.set(humanStatusContext).at(-1), [sha, 'pending', 'Needs human review: Changes the layout.']);
});

test("gate withdraws the review's approvals when it cannot read the summary or the PR", async (t) => {
  useSelfApprovers(t);
  const unread = client({ author: 'octocat', statuses: passing, failComments: true, reviews: [selfApproval()] });
  const k = core();
  await gate({ github: unread.github, context: context({ action: 'labeled', author: 'octocat' }), core: k });
  assert.match(k.failures.join('\n'), /Could not re-set the human review status of #7/u);
  assert.equal(unread.named('dismissReview').length, 1);

  // A PR that cannot be read loses every approval the review gave, of any head.
  const gone = client({ author: 'octocat', statuses: passing, reviews: [selfApproval('0123456789abcdef', 32)] });
  gone.github.rest.pulls.get = () => Promise.reject(new Error('Server Error'));
  await gate({ github: gone.github, context: context({ action: 'labeled', author: 'octocat' }), core: core() });
  assert.deepEqual(
    gone.named('dismissReview').map((d) => d.review_id),
    [32],
  );
  assert.deepEqual(gone.set(statusContext), []);
});
