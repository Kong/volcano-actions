'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { humanStatusContext, publish, gate } = require('./ai-review.cjs');
const { decisionMarker } = require('./decision.cjs');
const {
  sha,
  output,
  routine,
  review,
  claudeReviews,
  clearAfter,
  client,
  context,
  core,
} = require('./test-helpers.cjs');

const owners = ['# Marketing', 'web/** @octocat @hubot', '**/billing/** monalisa', 'web/billing/legal/**'].join('\n');
const needed = { needed: true, reasons: ['Changes the pricing page.'] };
const files = [{ filename: 'web/pricing.tsx' }, { filename: 'web/billing/plan.ts' }];

function useOwners(t, lines = owners) {
  process.env.OWNERS = lines;
  clearAfter(t, 'OWNERS');
}

// Publishes a review with this human decision, and returns the human status,
// the summary comment, and who was asked to review.
async function publishOwned(t, human, options = {}) {
  claudeReviews(t, 'success', output([], 'Edits the pricing page.', human));
  const c = client({ files, ...options });
  const k = core();
  await publish({ github: c.github, context: context({ author: options.author ?? 'author' }), core: k });
  assert.deepEqual(k.failures, []);
  return {
    status: c.set(humanStatusContext)[0].slice(1),
    body: c.named('createComment')[0].body,
    asked: c.named('requestReviewers').map((r) => r.reviewers),
  };
}

test('a PR that needs a person needs an approval from an owner of each owned path', async (t) => {
  useOwners(t);
  const approvedBy = async (...logins) =>
    (await publishOwned(t, needed, { reviews: logins.map((l) => review(l, 'APPROVED')) })).status;
  // Billing files on the marketing site are billing's, the last line matching them.
  assert.deepEqual(await approvedBy('reviewer'), [
    'pending',
    'Needs an approval from an owner of web/pricing.tsx: octocat, hubot.',
  ]);
  assert.deepEqual(await approvedBy('Hubot'), [
    'pending',
    'Needs an approval from an owner of web/billing/plan.ts: monalisa.',
  ]);
  assert.deepEqual(await approvedBy('hubot', 'monalisa'), ['success', 'Approved by hubot, monalisa.']);
  // Without an approval yet, the review's reason leads, and the owners are asked.
  const none = await publishOwned(t, needed);
  assert.deepEqual(none.status, ['pending', 'Needs human review: Changes the pricing page.']);
  assert.deepEqual(none.asked, [['octocat', 'hubot', 'monalisa']]);
  assert.match(
    none.body,
    /An approval counts only from an owner of the changed paths: one of `octocat`, `hubot` \(owns `web\/pricing\.tsx`\); one of `monalisa` \(owns `web\/billing\/plan\.ts`\)\./u,
  );
});

test('owners matter only when a person is needed, and never the author', async (t) => {
  useOwners(t);
  assert.deepEqual((await publishOwned(t, routine)).status, ['success', 'No human review needed.']);
  const anyone = await publishOwned(t, routine, { reviews: [review('reviewer', 'APPROVED')] });
  assert.deepEqual(anyone.status, ['success', 'Approved by reviewer.']);
  // A path only its author owns takes any approval; an unowned path, too.
  const own = await publishOwned(t, needed, {
    author: 'monalisa',
    files: [{ filename: 'web/billing/plan.ts' }, { filename: 'web/billing/legal/terms.md' }, { filename: 'api.go' }],
    reviews: [review('reviewer', 'APPROVED')],
  });
  assert.deepEqual(own.status, ['success', 'Approved by reviewer.']);
  // Unlisted files take any owner.
  const unlisted = await publishOwned(t, needed, { failFiles: true, reviews: [review('reviewer', 'APPROVED')] });
  assert.deepEqual(unlisted.status, [
    'pending',
    'Needs an approval from an owner of the changed files: octocat, hubot, monalisa.',
  ]);
});

test('without owners, the summary and its marker stay as they were', async (t) => {
  const { body } = await publishOwned(t, needed);
  assert.match(body, /Any collaborator with write access other than the author can approve\./u);
  const decision = JSON.parse(
    Buffer.from(body.match(/<!-- ai-review-human (\S+) -->$/u)[1], 'base64').toString('utf8'),
  );
  assert.equal(Object.hasOwn(decision, 'owners'), false);
});

test('later events hold approvals to the owners the summary recorded', async () => {
  // The owners setting is not read again: gate uses the recorded groups.
  const recorded = [{ path: 'web/pricing.tsx', logins: ['octocat'] }];
  const comment = {
    id: 2,
    user: { login: 'github-actions[bot]' },
    body: `<!-- ai-review-verdict -->\n\n${decisionMarker(sha, { reasons: ['Changes pricing.'], reviewer: null, owners: recorded })}`,
  };
  const statusAfter = async (approver) => {
    const c = client({ comments: [comment], reviews: [review(approver, 'APPROVED')] });
    await gate({ github: c.github, context: context({ action: 'labeled' }), core: core() });
    return c.set(humanStatusContext)[0][1];
  };
  assert.equal(await statusAfter('reviewer'), 'pending');
  assert.equal(await statusAfter('octocat'), 'success');
});
