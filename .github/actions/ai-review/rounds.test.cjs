'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, marker, publish } = require('./ai-review.cjs');
const { decisionMarker } = require('./decision.cjs');
const { roundLimit, nextRounds } = require('./rounds.cjs');
const { sha, finding, reviewJson, claudeReviews, client, context, core } = require('./test-helpers.cjs');

const opened = '2026-10-23T10:00:00Z';
const ready = '2026-10-24T09:00:00Z';
const otherHead = 'fedcba9876543210';
const failingJson = reviewJson({ findings: [finding('p1')] });

// The summary comment as an earlier review left it, recording its rounds.
const summary = (rounds, head = otherHead) => ({
  id: 2,
  user: { login: 'github-actions[bot]' },
  body: `${marker}\n### AI review: 1 P0-P2 finding(s)\n\n${decisionMarker(head, { reasons: [], reviewer: null, rounds })}`,
});
const twoFailed = summary({ since: opened, count: 2, sha: otherHead });
const recorded = (body) =>
  JSON.parse(Buffer.from(body.match(/\n<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u)[1], 'base64').toString('utf8'))
    .rounds;

// The verdict publish set, which the fake reads back as the head's status.
const failed = [{ context: statusContext, state: 'failure', description: '1 P0-P2 finding(s).' }];

async function publishRound(t, { json = failingJson, result = 'success', ...options }) {
  claudeReviews(t, result, json);
  const c = client({ statuses: failed, ...options });
  const k = core();
  await publish({ github: c.github, context: context(), core: k });
  const written = [...c.named('createComment'), ...c.named('updateComment')];
  const summaryBody = written.find((w) => w.body.startsWith(marker))?.body;
  const handOff = c.named('createComment').find((w) => w.body.startsWith('<!-- ai-review-rounds -->'));
  return { c, k, summaryBody, handOff, drafted: c.named('graphql') };
}

test('the round limit is three', () => {
  assert.equal(roundLimit, 3);
});

test('each failing round before the limit says which it is and leaves the PR ready', async (t) => {
  for (const [stored, count] of [
    [null, 1],
    [{ since: opened, count: 1, sha: otherHead }, 2],
  ]) {
    const { summaryBody, handOff, drafted } = await publishRound(t, { comments: stored ? [summary(stored)] : [] });
    assert.deepEqual(recorded(summaryBody), { since: opened, count, sha });
    assert.match(summaryBody, new RegExp(`\\nFailing round ${count} of 3 since this PR was last marked ready`, 'u'));
    assert.equal(handOff, undefined);
    assert.deepEqual(drafted, []);
  }
});

test('a third failing round in a row moves the PR to draft and asks the author to re-assess', async (t) => {
  const { k, summaryBody, handOff, drafted, c } = await publishRound(t, { comments: [twoFailed] });
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 3, sha });
  assert.match(summaryBody, /\n3 rounds in a row have found P0-P2 problems .*, so the AI review asks the author/u);
  assert.deepEqual(
    drafted.map((d) => d.id),
    ['PR_7'],
  );
  assert.match(drafted[0].query, /convertPullRequestToDraft/u);
  assert.match(handOff.body, /^<!-- ai-review-rounds -->\n### AI review: re-assess the approach\n\n@author, /u);
  assert.match(
    handOff.body,
    /in 3 rounds in a row, through abcdef1, .*moved this PR back to draft, where it reviews no/u,
  );
  for (const option of ['Split it', 'Simplify the design', 'Rethink the approach', 'Push back']) {
    assert.ok(handOff.body.includes(`- **${option}**`), option);
  }
  assert.match(
    handOff.body,
    /\*\*Coding agents:\*\* stop here and do not push another fix .* wait for the author's decision before changing the code or marking the PR ready for review\./u,
  );
  assert.match(
    handOff.body,
    /starts a new set of 3 rounds .* once that review finishes, add the `ai-review-override` label\.$/u,
  );
  assert.equal(handOff.issue_number, 7);
  assert.deepEqual(
    c.set(statusContext).map(([, state]) => state),
    ['failure'],
  );
  assert.deepEqual(k.failures, []);
});

test('a passing round has converged and resets the count', async (t) => {
  const passing = await publishRound(t, { json: reviewJson({ findings: [finding('p3')] }), comments: [twoFailed] });
  assert.deepEqual(recorded(passing.summaryBody), { since: opened, count: 0, sha });
  assert.doesNotMatch(passing.summaryBody, /round/iu);
  assert.equal(passing.handOff, undefined);

  const after = await publishRound(t, { comments: [summary({ since: opened, count: 0, sha: otherHead })] });
  assert.deepEqual(recorded(after.summaryBody), { since: opened, count: 1, sha });
  assert.equal(after.handOff, undefined);
});

test('marking the PR ready for review again starts a new set of rounds', async (t) => {
  const { summaryBody, handOff } = await publishRound(t, {
    comments: [summary({ since: opened, count: 3, sha: otherHead })],
    timeline: [
      { event: 'convert_to_draft', created_at: '2026-10-24T08:00:00Z' },
      { event: 'ready_for_review', created_at: ready },
      { event: 'labeled', created_at: '2026-10-24T10:00:00Z' },
    ],
  });
  assert.deepEqual(recorded(summaryBody), { since: ready, count: 1, sha });
  assert.equal(handOff, undefined);
});

test('reopening the PR also starts a new set of rounds', async (t) => {
  const { summaryBody } = await publishRound(t, {
    comments: [twoFailed],
    timeline: [{ event: 'reopened', created_at: ready }],
  });
  assert.deepEqual(recorded(summaryBody), { since: ready, count: 1, sha });
});

test('a re-run of a failed head repeats its round, and a review that did not complete is no round', () => {
  const stored = { count: 2, sha };
  assert.deepEqual(nextRounds(stored, opened, sha, 'failure'), { since: opened, count: 2, sha });
  assert.deepEqual(nextRounds(stored, opened, otherHead, 'error'), { since: opened, count: 2, sha });
  assert.deepEqual(nextRounds({ count: 0, sha }, opened, sha, 'failure'), { since: opened, count: 1, sha });
  assert.deepEqual(nextRounds({ count: 0, sha: null }, opened, sha, 'error'), { since: opened, count: 0, sha: null });
});

test('a review that did not complete keeps the count it found', async (t) => {
  const { summaryBody, handOff } = await publishRound(t, { json: '', result: 'failure', comments: [twoFailed] });
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 2, sha: otherHead });
  assert.doesNotMatch(summaryBody, /round/iu);
  assert.equal(handOff, undefined);
});

test('a count from an earlier set is not this set', async (t) => {
  const { summaryBody } = await publishRound(t, {
    comments: [summary({ since: '2026-10-01T00:00:00Z', count: 2, sha })],
  });
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 1, sha });
});

test('the PR is read again before the hand-off, and only a ready PR at this head is handed off', async (t) => {
  for (const options of [{ draft: true }, { state: 'closed' }, { liveHead: otherHead }]) {
    const { handOff, drafted } = await publishRound(t, { comments: [twoFailed], ...options });
    assert.equal(handOff, undefined, JSON.stringify(options));
    assert.deepEqual(drafted, [], JSON.stringify(options));
  }
  // A push lands after the summary and inline comments were written.
  let reads = 0;
  const { summaryBody, handOff, drafted, c } = await publishRound(t, {
    comments: [twoFailed],
    liveHead: () => {
      reads += 1;
      return reads > 3 ? otherHead : sha;
    },
  });
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 3, sha });
  assert.equal(c.named('getPull').length, 4);
  assert.equal(handOff, undefined);
  assert.deepEqual(drafted, []);
});

test('a failed draft conversion only warns, says the review goes on, and asks once per set', async (t) => {
  const first = await publishRound(t, { comments: [twoFailed], failDraft: true });
  assert.deepEqual(first.k.failures, []);
  assert.match(first.k.warnings.join('\n'), /Could not move the PR back to draft after 3 failing rounds/u);
  assert.match(
    first.handOff.body,
    /could not move this PR back to draft, so it keeps reviewing each push\. Convert the PR to draft yourself/u,
  );
  assert.doesNotMatch(first.handOff.body, /reviews no pushes/u);

  const asked = {
    id: 3,
    user: { login: 'github-actions[bot]' },
    body: '<!-- ai-review-rounds -->\n### AI review: re-assess the approach',
    created_at: '2026-10-24T12:00:00Z',
  };
  const again = await publishRound(t, {
    comments: [summary({ since: opened, count: 3, sha: otherHead }), asked],
    failDraft: true,
  });
  assert.equal(again.drafted.length, 1);
  assert.equal(again.handOff, undefined);
  // A hand-off from an earlier set does not count for this one.
  const older = await publishRound(t, {
    comments: [summary({ since: ready, count: 2, sha: otherHead }), { ...asked, created_at: opened }],
    timeline: [{ event: 'ready_for_review', created_at: ready }],
  });
  assert.ok(older.handOff);
});

test('the hand-off names a human author, and never mentions a bot', async (t) => {
  for (const [user, ask] of [
    [{ login: 'octo-dev', type: 'User' }, /\n@octo-dev, the AI review/u],
    [{ login: 'kong-volcano-app[bot]', type: 'Bot' }, /\nPR author, the AI review/u],
  ]) {
    const { handOff } = await publishRound(t, { comments: [twoFailed], author: user });
    assert.match(handOff.body, ask);
    assert.doesNotMatch(handOff.body, /@kong-volcano-app/u);
  }
});

test('an unreadable timeline keeps the recorded count and only warns', async (t) => {
  const { k, summaryBody, handOff, c } = await publishRound(t, { comments: [twoFailed], failTimeline: true });
  assert.deepEqual(k.failures, []);
  assert.match(k.warnings.join('\n'), /Could not count the AI review's rounds/u);
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 2, sha: otherHead });
  assert.doesNotMatch(summaryBody, /round/iu);
  assert.equal(handOff, undefined);
  assert.deepEqual(
    c.set(statusContext).map(([, state]) => state),
    ['failure'],
  );
});

test('an override accepted while the review published is not undone by a hand-off', async (t) => {
  const overridden = [{ context: statusContext, state: 'success', description: 'Failing verdict overridden by lead.' }];
  const { summaryBody, handOff, drafted } = await publishRound(t, { comments: [twoFailed], statuses: overridden });
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 3, sha });
  assert.equal(handOff, undefined);
  assert.deepEqual(drafted, []);
});

test('a failed read of the summary while counting keeps the count the summary holds', async (t) => {
  const { k, summaryBody, handOff } = await publishRound(t, { comments: [twoFailed], failComments: 1 });
  assert.match(k.warnings.join('\n'), /Could not count the AI review's rounds/u);
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 2, sha: otherHead });
  assert.doesNotMatch(summaryBody, /round/iu);
  assert.equal(handOff, undefined);
});
