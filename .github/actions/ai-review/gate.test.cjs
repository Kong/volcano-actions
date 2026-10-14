'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, humanLabel, marker, publish, gate } = require('./ai-review.cjs');
const { sha, output, routine, review, decided, claudeReviews, client, context, core } = require('./test-helpers.cjs');

test('gate re-sets the live head after a review event, by its head branch', async () => {
  const workflowRun = {
    event: 'pull_request_review',
    head_sha: sha,
    head_branch: 'feature',
    head_repository: { owner: { login: 'Kong' } },
  };
  const c = client({
    open: [{ number: 7 }, { number: 9 }],
    comments: [decided([])],
    reviews: [review('reviewer', 'CHANGES_REQUESTED')],
  });
  await gate({ github: c.github, context: context({ workflowRun }), core: core() });
  assert.deepEqual(
    c.named('listPulls').map((l) => [l.head, l.state]),
    [['Kong:feature', 'open']],
  );
  assert.deepEqual(
    c.named('getPull').map((g) => g.pull_number),
    [7, 9],
  );
  assert.deepEqual(c.set(humanStatusContext), [
    [sha, 'pending', 'Changes requested by reviewer.'],
    [sha, 'pending', 'Changes requested by reviewer.'],
  ]);

  // A fork's review run names the fork's owner.
  const fork = client({
    headRepo: 'someone/volcano-hosting',
    open: [{ number: 7 }],
    reviews: [review('reviewer', 'APPROVED')],
  });
  await gate({
    github: fork.github,
    context: context({ workflowRun: { ...workflowRun, head_repository: { owner: { login: 'someone' } } } }),
    core: core(),
  });
  assert.deepEqual(
    fork.named('listPulls').map((l) => l.head),
    ['someone:feature'],
  );
  assert.deepEqual(fork.set(humanStatusContext), [[sha, 'success', 'Approved by reviewer.']]);
});

test('gate decides from the review the summary comment records for the live head', async () => {
  const run = async (options) => {
    const c = client(options);
    await gate({ github: c.github, context: context({ action: 'labeled' }), core: core() });
    return c.set(humanStatusContext);
  };
  assert.deepEqual(await run({ comments: [decided([])] }), [[sha, 'success', 'No human review needed.']]);
  assert.deepEqual(await run({ comments: [decided(['Changes billing.'])] }), [
    [sha, 'pending', 'Needs human review: Changes billing.'],
  ]);
  assert.deepEqual(await run({ comments: [decided([])], labels: [{ name: humanLabel }] }), [
    [sha, 'pending', `Needs human review: The ${humanLabel} label asks for one.`],
  ]);
  assert.deepEqual(
    await run({
      comments: [decided([])],
      statuses: [{ context: statusContext, state: 'success', description: 'Failing verdict overridden by author.' }],
    }),
    [[sha, 'pending', 'Needs human review: Failing verdict overridden by author.']],
  );

  // Without a decision for the live head, its review sets the status when it lands.
  for (const comments of [
    [],
    [decided([], 'fedcba9876543210')],
    [{ ...decided([]), user: { login: 'someone' } }],
    [{ ...decided([]), body: `${marker}\nold` }],
  ]) {
    assert.deepEqual(await run({ comments, reviews: [review('reviewer', 'APPROVED')] }), [], JSON.stringify(comments));
  }
  assert.deepEqual(await run({ comments: [decided([])], state: 'closed' }), []);
  // Only the marker that ends the comment counts, not a lookalike in a reviewer's text.
  const real = decided(['Changes billing.']);
  const lookalike = decided([]).body.split('\n').pop();
  const forged = { ...real, body: real.body.replace('### AI review', `Summary\n${lookalike}\n### AI review`) };
  assert.deepEqual(await run({ comments: [forged] }), [[sha, 'pending', 'Needs human review: Changes billing.']]);
  // A fork has no review to wait for.
  assert.deepEqual(await run({ headRepo: 'someone/volcano-hosting' }), [
    [sha, 'pending', 'Needs human review: The AI review does not run on fork PRs.'],
  ]);
});

test('gate reads the comment that publish writes', async (t) => {
  for (const [human, want] of [
    [routine, 'No human review needed.'],
    [{ needed: true, reasons: ['Changes --> billing.'] }, 'Needs human review: Changes --> billing.'],
  ]) {
    claudeReviews(t, 'success', output([], 'Adds a cache.', human));
    const published = client();
    await publish({ github: published.github, context: context(), core: core() });
    const [{ body }] = published.named('createComment');
    const c = client({ comments: [{ id: 2, user: { login: 'github-actions[bot]' }, body }] });
    await gate({ github: c.github, context: context({ action: 'unlabeled' }), core: core() });
    assert.deepEqual(
      c.set(humanStatusContext).map(([, , description]) => description),
      [want],
    );
  }
});

const reviewRun = 'https://github.com/Kong/volcano-hosting/actions/runs/1';
const errored = {
  context: statusContext,
  state: 'error',
  description: 'Review did not complete. Re-run it, or have a writer approve this commit.',
  target_url: reviewRun,
};
const fallback = {
  context: statusContext,
  state: 'success',
  description: 'Review did not complete; approved by reviewer.',
  target_url: reviewRun,
};

// Runs the gate for a head whose review did not complete.
async function gateAfter(statuses, reviews, comments = [decided(['No AI review completed.'])]) {
  const c = client({ statuses: [statuses].flat(), reviews, comments });
  await gate({ github: c.github, context: context({ action: 'labeled' }), core: core() });
  return c;
}

test('an approval of the exact commit stands in for a review that did not complete', async () => {
  const approved = await gateAfter(errored, [review('reviewer', 'APPROVED')]);
  assert.deepEqual(approved.set(humanStatusContext), [[sha, 'success', 'Approved by reviewer.']]);
  assert.deepEqual(approved.set(statusContext), [[sha, 'success', 'Review did not complete; approved by reviewer.']]);
  // The fallback keeps pointing at the review's run, not the gate's.
  assert.deepEqual(
    approved
      .named('createCommitStatus')
      .filter((st) => st.context === statusContext)
      .map((st) => st.target_url),
    [reviewRun],
  );

  // Nobody read this commit, or the approval cannot count.
  for (const reviews of [
    [review('reviewer', 'APPROVED', 'User', 'fedcba9876543210')],
    [review('author', 'APPROVED')],
    [review('copilot', 'APPROVED', 'Bot')],
    [review('reviewer', 'COMMENTED')],
    [review('reviewer', 'APPROVED'), review('reviewer', 'DISMISSED')],
    [],
  ]) {
    assert.deepEqual((await gateAfter(errored, reviews)).set(statusContext), [], JSON.stringify(reviews));
  }
  // Findings are never replaced by an approval, nor is a pending or passing verdict.
  for (const state of ['failure', 'pending', 'success']) {
    assert.deepEqual(
      (await gateAfter({ context: statusContext, state, description: 'x' }, [review('reviewer', 'APPROVED')])).set(
        statusContext,
      ),
      [],
      state,
    );
  }
});

test('withdrawing the approval restores the error, and only for this fallback', async () => {
  const withdrawn = await gateAfter(fallback, [review('reviewer', 'APPROVED'), review('reviewer', 'DISMISSED')]);
  assert.deepEqual(withdrawn.set(statusContext), [
    [sha, 'error', 'Review did not complete. Re-run it, or have a writer approve this commit.'],
  ]);
  assert.deepEqual(
    withdrawn
      .named('createCommitStatus')
      .filter((st) => st.context === statusContext)
      .map((st) => st.target_url),
    [reviewRun],
  );
  assert.deepEqual((await gateAfter(fallback, [review('reviewer', 'APPROVED')])).set(statusContext), []);
  // The names follow who still approves this commit.
  const changed = await gateAfter(fallback, [
    review('reviewer', 'APPROVED'),
    review('reviewer', 'DISMISSED'),
    review('other', 'APPROVED'),
  ]);
  assert.deepEqual(changed.set(statusContext), [[sha, 'success', 'Review did not complete; approved by other.']]);
  const overridden = { context: statusContext, state: 'success', description: 'Failing verdict overridden by author.' };
  assert.deepEqual((await gateAfter(overridden, [])).set(statusContext), []);
});

test('publish accepts an approval of the commit whose review then fails', async (t) => {
  claudeReviews(t, 'failure');
  // The verdict publish just wrote reads back as an error.
  const c = client({
    statuses: [{ context: statusContext, state: 'error' }],
    reviews: [review('reviewer', 'APPROVED')],
  });
  await publish({ github: c.github, context: context(), core: core() });
  assert.deepEqual(
    c.set(statusContext).map(([, state, description]) => [state, description]),
    [
      ['error', 'Review did not complete. Re-run it, or have a writer approve this commit.'],
      ['success', 'Review did not complete; approved by reviewer.'],
    ],
  );
});
