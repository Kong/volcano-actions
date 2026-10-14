'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanLabel, publish, override, gate } = require('./ai-review.cjs');
const { sha, output, routine, review, decided, claudeReviews, client, context, core } = require('./test-helpers.cjs');

const needed = {
  needed: true,
  reasons: ['Changes billing.'],
  reviewer: 'bob',
  reviewer_reason: 'wrote internal/billing',
};

const candidates = JSON.stringify(['alice', 'bob', 'not a login', 7]);

// Publishes a clean review with this human decision; returns whom it asked.
async function publishAsking(t, human, options = {}, found = candidates) {
  claudeReviews(t, 'success', output([], 'Adds a cache.', human), found);
  const c = client(options);
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  assert.deepEqual(k.failures, []);
  return {
    requested: c.named('requestReviewers').map((r) => [r.pull_number, r.reviewers]),
    body: c.named('createComment')[0]?.body,
    warnings: k.warnings,
  };
}

test('publish asks the suggested reviewer when the head waits on its first human review', async (t) => {
  const asked = await publishAsking(t, needed);
  assert.deepEqual(asked.requested, [[7, ['bob']]]);
  assert.match(
    asked.body,
    /\n\nSuggested reviewer: `bob` \(wrote internal\/billing\)\. Any collaborator with write access other than the author can approve\.\n/u,
  );

  // A team request, as CODEOWNERS makes, still gets a person by name.
  assert.deepEqual((await publishAsking(t, needed, { requestedTeams: [{ slug: 'team-volcano' }] })).requested, [
    [7, ['bob']],
  ]);
  for (const options of [
    { requested: [{ login: 'carol' }] },
    { reviews: [review('carol', 'COMMENTED')] },
    { reviews: [review('carol', 'CHANGES_REQUESTED')] },
    { reviews: [review('carol', 'APPROVED')] },
    { draft: true },
    { state: 'closed' },
    { liveHead: 'fedcba9876543210' },
  ]) {
    assert.deepEqual((await publishAsking(t, needed, options)).requested, [], JSON.stringify(options));
  }
  // A bot's review does not count as a person's.
  assert.deepEqual((await publishAsking(t, needed, { reviews: [review('copilot', 'COMMENTED', 'Bot')] })).requested, [
    [7, ['bob']],
  ]);
});

test('publish asks no one without a need or candidates, and a failed request only warns', async (t) => {
  const quiet = await publishAsking(t, { ...routine, reviewer: 'bob', reviewer_reason: 'wrote internal/billing' });
  assert.deepEqual(quiet.requested, []);
  assert.doesNotMatch(quiet.body, /Suggested reviewer/u);

  const failed = await publishAsking(t, needed, { failRequest: true });
  assert.equal(failed.warnings.length, 1);
  assert.match(failed.warnings[0], /Could not request a review from bob/u);

  const nobody = await publishAsking(t, needed, {}, '');
  assert.deepEqual(nobody.requested, []);
  assert.match(nobody.body, /\n\nAny collaborator with write access other than the author can approve\.\n/u);
});

test('later events ask the reviewer the review suggested', async (t) => {
  // The suggestion survives in the comment even when no person was needed yet.
  claudeReviews(
    t,
    'success',
    output([], 'Adds a cache.', { ...routine, reviewer: 'bob', reviewer_reason: 'wrote internal/billing' }),
    '["alice","bob"]',
  );
  const published = client();
  await publish({ github: published.github, context: context(), core: core() });
  const [{ body }] = published.named('createComment');

  const labeled = client({
    comments: [{ id: 2, user: { login: 'github-actions[bot]' }, body }],
    labels: [{ name: humanLabel }],
  });
  await gate({ github: labeled.github, context: context({ action: 'labeled' }), core: core() });
  assert.deepEqual(
    labeled.named('requestReviewers').map((r) => r.reviewers),
    [['bob']],
  );

  const overridden = client({
    comments: [decided([], sha, { login: 'alice', why: 'x' })],
    statuses: [{ context: statusContext, state: 'failure' }],
  });
  await override({
    github: overridden.github,
    context: context({ sender: { login: 'author', type: 'User' } }),
    core: core(),
  });
  assert.deepEqual(
    overridden.named('requestReviewers').map((r) => r.reviewers),
    [['alice']],
  );

  // Nothing to ask for once the head passes, or without a suggestion.
  for (const comments of [[decided([], sha, { login: 'alice', why: 'x' })], [decided(['Changes billing.'])]]) {
    const c = client({ comments });
    await gate({ github: c.github, context: context({ action: 'unlabeled' }), core: core() });
    assert.deepEqual(c.named('requestReviewers'), [], JSON.stringify(comments));
  }
});
