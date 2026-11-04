'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, humanLabel, gate, override } = require('./ai-review.cjs');
const { unwithdrawn } = require('./self-approval.cjs');
const { sha, finding, review, decided, context, core } = require('./test-helpers.cjs');
const { client, passing, selfApproval, useSelfApprovers, publishFor } = require('./self-approval-fakes.cjs');

test('publish gives no approval, and withdraws its own, when the head needs a person', async (t) => {
  useSelfApprovers(t);
  const given = [selfApproval()];
  const cases = {
    'a reviewer asks for one': { human: { needed: true, reasons: ['Should the pricing page change the plan price?'] } },
    'the verdict fails': { findings: [finding('p1')], statuses: [{ context: statusContext, state: 'failure' }] },
    'the label asks for one': { labels: [{ name: humanLabel }] },
    'a person requested changes': { reviews: [review('reviewer', 'CHANGES_REQUESTED')] },
  };
  for (const [name, options] of Object.entries(cases)) {
    const { c } = await publishFor(t, { ...options, reviews: [...given, ...(options.reviews ?? [])] });
    assert.deepEqual(c.named('createReview'), [], name);
    assert.deepEqual(
      c.named('dismissReview').map((d) => [d.review_id, d.event]),
      [[31, 'DISMISS']],
      name,
    );
  }
});

test('a new head gets its own approval in place of the last one', async (t) => {
  useSelfApprovers(t);
  const { c } = await publishFor(t, { reviews: [selfApproval('0123456789abcdef', 30)] });
  assert.deepEqual(
    c.named('dismissReview').map((d) => d.review_id),
    [30],
  );
  // The earlier approval goes before the new head's verdict can pass on it.
  const order = c.calls.filter((call) => ['dismissReview', 'createCommitStatus'].includes(call.call));
  assert.equal(order[0].call, 'dismissReview');
  assert.deepEqual(
    c.named('createReview').map((r) => r.commit_id),
    [sha],
  );
});

test('a review of a head the PR moved past leaves the approvals alone', async (t) => {
  useSelfApprovers(t);
  const { c } = await publishFor(t, { liveHead: 'fedcba9876543210', reviews: [selfApproval('fedcba9876543210')] });
  assert.deepEqual(c.named('createReview'), []);
  assert.deepEqual(c.named('dismissReview'), []);
});

test('the label withdraws the approval even where the stub names no self-approvers', async () => {
  const c = client({
    author: 'octocat',
    statuses: passing,
    comments: [decided([])],
    labels: [{ name: humanLabel }],
    reviews: [selfApproval()],
  });
  const k = core();
  await gate({ github: c.github, context: context({ action: 'labeled', author: 'octocat' }), core: k });
  assert.deepEqual(
    c.named('dismissReview').map((d) => d.review_id),
    [31],
  );
  assert.deepEqual(c.named('createReview'), []);
  assert.deepEqual(c.set(humanStatusContext), [
    [sha, 'pending', `Needs human review: The ${humanLabel} label asks for one.`],
  ]);
});

test('an override withdraws the approval, since a person must accept the findings', async (t) => {
  useSelfApprovers(t);
  const c = client({
    author: 'octocat',
    statuses: [{ context: statusContext, state: 'failure' }],
    comments: [decided([])],
    reviews: [selfApproval()],
  });
  await override({ github: c.github, context: context({ action: 'labeled', author: 'octocat' }), core: core() });
  assert.deepEqual(
    c.named('dismissReview').map((d) => d.review_id),
    [31],
  );
  assert.deepEqual(c.named('createReview'), []);
});

test('a failed withdrawal fails the job, and a failed approval only warns', async (t) => {
  useSelfApprovers(t);
  const withdrawn = await publishFor(t, {
    human: { needed: true, reasons: ['Changes billing.'] },
    reviews: [selfApproval()],
    failDismiss: true,
  });
  assert.equal(withdrawn.k.failures.length, 1);
  assert.match(withdrawn.k.failures[0], /Could not withdraw the AI review's approval 31/u);

  const approved = await publishFor(t, { failApprove: true });
  assert.deepEqual(approved.k.failures, []);
  assert.match(approved.k.warnings.at(-1), /Could not approve abcdef1 for octocat/u);
});

test('a stale approval that cannot be withdrawn fails the verdict before it passes', async (t) => {
  useSelfApprovers(t);
  const { c, k } = await publishFor(t, { reviews: [selfApproval('0123456789abcdef', 30)], failDismiss: true });
  // It never passes, and the later sync tries the withdrawal again.
  const verdicts = c.set(statusContext);
  assert.ok(verdicts.length > 0);
  assert.deepEqual(
    new Set(verdicts.map((v) => JSON.stringify(v))),
    new Set([JSON.stringify([sha, 'failure', unwithdrawn])]),
  );
  assert.deepEqual(c.named('createReview'), []);
  assert.match(k.failures[0], /Could not withdraw the AI review's approval 30/u);
});

test('an approval of the head that cannot be withdrawn fails the verdict, and an override cannot pass it', async (t) => {
  useSelfApprovers(t);
  const human = { needed: true, reasons: ['Changes billing.'] };
  const { c } = await publishFor(t, { human, reviews: [selfApproval()], failDismiss: true });
  assert.deepEqual(c.set(statusContext).at(-1), [sha, 'failure', unwithdrawn]);

  const o = client({
    author: 'octocat',
    statuses: [{ context: statusContext, state: 'failure', target_url: 'https://run' }],
    comments: [decided([])],
    reviews: [selfApproval()],
    failDismiss: true,
  });
  const k = core();
  await override({ github: o.github, context: context({ action: 'labeled', author: 'octocat' }), core: k });
  assert.deepEqual(o.set(statusContext), [[sha, 'failure', unwithdrawn]]);
  assert.equal(o.named('createCommitStatus').find((s) => s.context === statusContext).target_url, 'https://run');
  assert.equal(o.named('removeLabel').length, 1);
});

test('without self-approvers, unread reviews keep the verdict; with them, the verdict fails', async (t) => {
  const plain = await publishFor(t, { failReviews: true });
  assert.equal(plain.c.set(statusContext)[0][1], 'success');
  useSelfApprovers(t);
  const listed = await publishFor(t, { failReviews: true });
  assert.deepEqual(listed.c.set(statusContext)[0], [sha, 'failure', unwithdrawn]);
});

// A dismissed approval of the head, and the timeline event that dismissed it.
const dismissedBy = (login) => ({
  reviews: [{ ...selfApproval(), state: 'DISMISSED' }],
  timeline: [{ event: 'review_dismissed', actor: { login }, dismissed_review: { review_id: 31 } }],
});

test('a person who dismisses the approval keeps it off that commit', async (t) => {
  useSelfApprovers(t);
  const gateWith = async (options) => {
    const c = client({ author: 'octocat', statuses: passing, comments: [decided([])], ...options });
    const k = core();
    await gate({ github: c.github, context: context({ action: 'unlabeled', author: 'octocat' }), core: k });
    return { approved: c.named('createReview').length, k };
  };
  assert.equal((await gateWith(dismissedBy('reviewer'))).approved, 0);
  // The review's own withdrawal, as for the label, does not.
  assert.equal((await gateWith(dismissedBy('github-actions[bot]'))).approved, 1);
  // Nor does a person's dismissal of an earlier commit's approval.
  const earlier = dismissedBy('reviewer');
  earlier.reviews[0].commit_id = '0123456789abcdef';
  assert.equal((await gateWith(earlier)).approved, 1);
  // An unread timeline gives no approval.
  const unread = await gateWith({ ...dismissedBy('github-actions[bot]'), failTimeline: true });
  assert.equal(unread.approved, 0);
  assert.match(unread.k.warnings.at(-1), /Could not read who dismissed/u);
});
