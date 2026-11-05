'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, gate } = require('./ai-review.cjs');
const { policy } = require('./prepare.cjs');
const { selfApprovalMarker, selfApproverOf } = require('./self-approval.cjs');
const { sha, decided, context, core } = require('./test-helpers.cjs');
const {
  client,
  passing,
  selfApproval,
  approvers,
  useSelfApprovers,
  publishFor,
  decidedWithin,
} = require('./self-approval-fakes.cjs');

test("publish approves a self-approver's head when nothing calls for a person", async (t) => {
  useSelfApprovers(t);
  const { c, k } = await publishFor(t);
  assert.deepEqual(k.failures, []);
  const [approval] = c.named('createReview');
  assert.equal(approval.event, 'APPROVE');
  assert.equal(approval.commit_id, sha);
  assert.equal(approval.pull_number, 7);
  assert.ok(approval.body.startsWith(`${selfApprovalMarker}\n`));
  assert.match(approval.body, /octocat may merge/u);
  assert.deepEqual(c.named('dismissReview'), []);
  // The approval is not a person's: the human status stays the review's call.
  assert.deepEqual(c.set(humanStatusContext), [[sha, 'success', 'No human review needed.']]);

  // Logins match without regard to case. A review of the same head again
  // withdraws its approval before the verdict, and approves once it clears.
  process.env.SELF_APPROVERS = 'OctoCat: a change only to styling';
  const again = await publishFor(t, { reviews: [selfApproval()] });
  const order = again.c.calls
    .filter((call) => ['dismissReview', 'createCommitStatus', 'createReview'].includes(call.call))
    .map((call) => (call.context ? `${call.context} ${call.state}` : call.call));
  assert.deepEqual(order.slice(0, 2), ['dismissReview', `${statusContext} success`]);
  assert.equal(order.at(-1), 'createReview');
  assert.equal(again.c.named('dismissReview')[0].message, 'The AI review no longer approves abcdef1 without a person.');
});

test('publish approves only self-approvers', async (t) => {
  useSelfApprovers(t);
  const { c } = await publishFor(t, { author: 'someone' });
  assert.deepEqual(c.named('createReview'), []);
  // Nothing to withdraw and nobody to approve skips the verdict read that a
  // self-approver's head takes.
  const listed = await publishFor(t, { author: 'octocat' });
  const reads = (run) => run.named('getCombinedStatusForRef').length;
  assert.equal(reads(c), reads(listed.c) - 1);
});

test('gate approves again once the label comes off', async (t) => {
  useSelfApprovers(t);
  const c = client({ author: 'octocat', statuses: passing, comments: [decidedWithin()] });
  await gate({ github: c.github, context: context({ action: 'unlabeled', author: 'octocat' }), core: core() });
  assert.deepEqual(
    c.named('createReview').map((r) => [r.commit_id, r.event]),
    [[sha, 'APPROVE']],
  );
});

test("the policy narrows each self-approver's decision to their own scope", (t) => {
  useSelfApprovers(t);
  const narrowed = policy(context({ author: 'hubot' }), '/in');
  assert.ok(
    narrowed.includes(
      'evidence either way.\nThe PR author may merge without a person only a change that is a change only to user-facing copy.\nAnything else needs a person',
    ),
  );
  assert.match(policy(context({ author: 'octocat' }), '/in'), /only a change that is a change only to styling\.\n/u);
  // Anyone else, or a self-approver with no scope, keeps the usual decision,
  // with no blank line.
  process.env.SELF_APPROVERS = `${approvers}\nhubot`;
  for (const text of [policy(context(), '/in'), policy(context({ author: 'hubot' }), '/in')]) {
    assert.ok(!text.includes('may merge without a person'));
    assert.ok(text.includes('evidence either way.\n\nSet not_checked'));
  }
});

test('the self-approvers parse one per line, and a line that does not parse names nobody', (t) => {
  useSelfApprovers(
    t,
    [
      'octocat: a change only to docs: guides and examples,',
      '  with no change to code',
      '',
      'Hubot , reviewed by  octocat',
      'not a login: anything',
      'monalisa reviewed by octocat: anything',
    ].join('\n'),
  );
  const person = (login) => ({ login, type: 'User' });
  assert.deepEqual(selfApproverOf(person('octocat')), {
    scopes: ['a change only to docs: guides and examples, with no change to code'],
    reviewer: null,
  });
  // A line with no scope leaves the review's usual decision.
  assert.deepEqual(selfApproverOf(person('hubot')), { scopes: [], reviewer: 'octocat' });
  assert.equal(selfApproverOf(person('not')), null);
  assert.equal(selfApproverOf(person('monalisa')), null);
  assert.equal(selfApproverOf(null), null);
});

test('`*` lines add their scopes for every person, and a login may have several', (t) => {
  useSelfApprovers(
    t,
    [
      'hubot, reviewed by octocat: a change only to user-facing copy',
      '*: a feature behind a flag',
      'hubot: a change only to styling',
    ].join('\n'),
  );
  assert.deepEqual(selfApproverOf({ login: 'hubot', type: 'User' }), {
    scopes: ['a change only to user-facing copy', 'a change only to styling', 'a feature behind a flag'],
    reviewer: 'octocat',
  });
  assert.deepEqual(selfApproverOf({ login: 'monalisa', type: 'User' }), {
    scopes: ['a feature behind a flag'],
    reviewer: null,
  });
  // Bots get only lines that name them.
  assert.equal(selfApproverOf({ login: 'dependabot[bot]', type: 'Bot' }), null);
  assert.equal(selfApproverOf({ login: 'Copilot', type: 'Bot' }), null);

  // The policy lists each scope.
  assert.match(
    policy(context({ author: 'hubot' }), '/in'),
    /evidence either way\.\nThe PR author may merge without a person only a change that is one of:\n- a change only to user-facing copy\n- a change only to styling\n- a feature behind a flag\nAnything else needs a person/u,
  );
});

test("a self-approver's named reviewer is the one asked when their PR needs a person", async (t) => {
  useSelfApprovers(t);
  const human = {
    needed: true,
    reasons: ['Should the pricing card change its layout?'],
    reviewer: 'bob',
    reviewer_reason: 'wrote the pricing page',
  };
  const { c } = await publishFor(t, { author: 'hubot', human, candidates: '["bob"]' });
  assert.deepEqual(
    c.named('requestReviewers').map((r) => r.reviewers),
    [['octocat']],
  );
  assert.match(
    c.named('createComment')[0]?.body ?? '',
    /Suggested reviewer: `octocat` \(reviews what hubot may not merge alone\)/u,
  );
  // Without a named reviewer, the review's suggestion stands.
  const own = await publishFor(t, { author: 'octocat', human, candidates: '["bob"]' });
  assert.deepEqual(
    own.c.named('requestReviewers').map((r) => r.reviewers),
    [['bob']],
  );
});

test("the review approves only a head whose review weighed the author's current scope", async (t) => {
  useSelfApprovers(t);
  const approvedWith = async (comment) => {
    const c = client({ author: 'octocat', statuses: passing, comments: [comment] });
    await gate({ github: c.github, context: context({ action: 'unlabeled', author: 'octocat' }), core: core() });
    return c.named('createReview').length;
  };
  assert.equal(await approvedWith(decidedWithin()), 1);
  // Reviewed before self-approval was enabled, or under another scope.
  assert.equal(await approvedWith(decided([])), 0);
  assert.equal(await approvedWith(decidedWithin('a change only to copy')), 0);

  // publish records the scope it weighed for a self-approver only.
  const recorded = async (author) => {
    const { c } = await publishFor(t, { author });
    const body = [...c.named('createComment'), ...c.named('updateComment')].at(-1).body;
    return JSON.parse(Buffer.from(body.match(/<!-- ai-review-human (\S+) -->$/u)[1], 'base64').toString('utf8')).scope;
  };
  assert.equal(await recorded('octocat'), 'a change only to styling');
  assert.equal(await recorded('someone'), undefined);
});
