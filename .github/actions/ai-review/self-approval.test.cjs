'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, humanLabel, publish, gate, override } = require('./ai-review.cjs');
const { policy } = require('./prepare.cjs');
const { selfApprovalMarker, selfApproverOf } = require('./self-approval.cjs');
const {
  sha,
  finding,
  output,
  routine,
  review,
  decided,
  claudeReviews,
  clearAfter,
  client: baseClient,
  context,
  core,
} = require('./test-helpers.cjs');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// The shared client, with the review writes this feature makes, which fail
// when `failApprove` or `failDismiss` is set.
function client({ failApprove = false, failDismiss = false, ...options } = {}) {
  const c = baseClient(options);
  const write = (call, failure) => (args) => {
    c.calls.push({ ...args, call });
    return failure ? Promise.reject(httpError(...failure)) : Promise.resolve({ data: {} });
  };
  c.github.rest.pulls.createReview = write('createReview', failApprove && ['Unprocessable Entity', 422]);
  c.github.rest.pulls.dismissReview = write('dismissReview', failDismiss && ['Forbidden', 403]);
  return c;
}

const passing = [
  { context: statusContext, state: 'success', description: 'No P0-P2 findings (0 P3, 0 pre-existing).' },
];
// An approval this review gave, of `commit`.
const selfApproval = (commit = sha, id = 31) => ({
  id,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  state: 'APPROVED',
  commit_id: commit,
  body: `${selfApprovalMarker}\nThe AI review found nothing.`,
});

const approvers = [
  'octocat: a change only to styling',
  'hubot, reviewed by octocat: a change only to user-facing copy',
].join('\n');

const useSelfApprovers = (t, entries = approvers) => {
  process.env.SELF_APPROVERS = entries;
  clearAfter(t, 'SELF_APPROVERS');
};

// Publishes a review with this human decision and findings for the author.
async function publishFor(t, { human = routine, findings = [], candidates, ...options } = {}) {
  claudeReviews(t, 'success', output(findings, 'Edits the hero copy.', human), candidates);
  const c = client({ author: 'octocat', statuses: passing, ...options });
  const k = core();
  await publish({ github: c.github, context: context({ author: options.author ?? 'octocat' }), core: k });
  return { c, k };
}

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

  // Logins match without regard to case, and an approval of the head stays.
  process.env.SELF_APPROVERS = 'OctoCat: a change only to styling';
  const again = await publishFor(t, { reviews: [selfApproval()] });
  assert.deepEqual(again.c.named('createReview'), []);
  assert.deepEqual(again.c.named('dismissReview'), []);
});

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

test('publish approves only self-approvers', async (t) => {
  useSelfApprovers(t);
  const { c } = await publishFor(t, { author: 'someone' });
  assert.deepEqual(c.named('createReview'), []);
  // Nothing to withdraw and nobody to approve costs no extra reads.
  delete process.env.SELF_APPROVERS;
  const unset = await publishFor(t, { author: 'someone' });
  assert.equal(c.named('getCombinedStatusForRef').length, unset.c.named('getCombinedStatusForRef').length);
});

test('a new head gets its own approval in place of the last one', async (t) => {
  useSelfApprovers(t);
  const { c } = await publishFor(t, { reviews: [selfApproval('0123456789abcdef', 30)] });
  assert.deepEqual(
    c.named('dismissReview').map((d) => d.review_id),
    [30],
  );
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

test('gate approves again once the label comes off', async (t) => {
  useSelfApprovers(t);
  const c = client({ author: 'octocat', statuses: passing, comments: [decided([])] });
  await gate({ github: c.github, context: context({ action: 'unlabeled', author: 'octocat' }), core: core() });
  assert.deepEqual(
    c.named('createReview').map((r) => [r.commit_id, r.event]),
    [[sha, 'APPROVE']],
  );
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
  assert.deepEqual(selfApproverOf('octocat'), {
    scope: 'a change only to docs: guides and examples, with no change to code',
    reviewer: null,
  });
  assert.deepEqual(selfApproverOf('hubot'), { scope: '', reviewer: 'octocat' });
  assert.equal(selfApproverOf('not'), null);
  assert.equal(selfApproverOf('monalisa'), null);
  assert.equal(selfApproverOf(null), null);
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
