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

// The summary comment as an earlier review left it, recording its rounds.
const summary = (rounds, head = otherHead) => ({
  id: 2,
  user: { login: 'github-actions[bot]' },
  body: `${marker}\n### AI review: 1 P0-P2 finding(s)\n\n${decisionMarker(head, { reasons: [], reviewer: null, rounds })}`,
});
const recorded = (body) =>
  JSON.parse(Buffer.from(body.match(/\n<!-- ai-review-human ([A-Za-z0-9+/=]+) -->$/u)[1], 'base64').toString('utf8'))
    .rounds;

async function publishRound(t, { json = reviewJson({ findings: [finding('p1')] }), result = 'success', ...options }) {
  claudeReviews(t, result, json);
  const c = client(options);
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
    const { summaryBody, handOff, drafted } = await publishRound(t, {
      comments: stored ? [summary(stored)] : [],
    });
    assert.deepEqual(recorded(summaryBody), { since: opened, count, sha });
    assert.match(
      summaryBody,
      new RegExp(`\\nRound ${count} of 3 since this PR was last marked ready for review\\. `, 'u'),
    );
    assert.equal(handOff, undefined);
    assert.deepEqual(drafted, []);
  }
});

test('a third failing round moves the PR to draft and asks a person to re-assess it', async (t) => {
  const { k, summaryBody, handOff, drafted, c } = await publishRound(t, {
    comments: [summary({ since: opened, count: 2, sha: otherHead })],
  });
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 3, sha });
  assert.match(summaryBody, /Round 3 of 3 .*, so the author re-assesses the approach/u);
  assert.deepEqual(
    drafted.map((d) => d.id),
    ['PR_7'],
  );
  assert.match(drafted[0].query, /convertPullRequestToDraft/u);
  assert.match(handOff.body, /^<!-- ai-review-rounds -->\n### AI review: re-assess the approach\n\n@author, /u);
  assert.match(handOff.body, /at abcdef1 after 3 rounds .*moved this PR back to draft and will not review more/u);
  for (const option of ['Split it', 'Simplify the design', 'Rethink the approach', 'Push back']) {
    assert.ok(handOff.body.includes(`- **${option}**`), option);
  }
  assert.match(
    handOff.body,
    /\*\*Coding agents:\*\* stop here and do not push another fix .* wait for the author's decision before changing the code or marking the PR ready for review\./u,
  );
  assert.match(handOff.body, /Marking the PR ready for review starts a new set of 3 rounds\.$/u);
  assert.equal(handOff.issue_number, 7);
  assert.deepEqual(
    c.set(statusContext).map(([, state]) => state),
    ['failure'],
  );
  assert.deepEqual(k.failures, []);
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
    comments: [summary({ since: opened, count: 2, sha: otherHead })],
    timeline: [{ event: 'reopened', created_at: ready }],
  });
  assert.deepEqual(recorded(summaryBody), { since: ready, count: 1, sha });
});

test('a re-run of the same head repeats its round, and a review that did not complete is no round', () => {
  const stored = { count: 2, sha };
  assert.deepEqual(nextRounds(stored, opened, sha, true), { since: opened, count: 2, sha });
  assert.deepEqual(nextRounds(stored, opened, otherHead, false), { since: opened, count: 2, sha });
  assert.deepEqual(nextRounds({ count: 0, sha: null }, opened, sha, false), { since: opened, count: 0, sha: null });
});

test('a review that did not complete keeps the count it found', async (t) => {
  const { summaryBody, handOff } = await publishRound(t, {
    json: '',
    result: 'failure',
    comments: [summary({ since: opened, count: 2, sha: otherHead })],
  });
  assert.deepEqual(recorded(summaryBody), { since: opened, count: 2, sha: otherHead });
  assert.doesNotMatch(summaryBody, /Round \d of 3/u);
  assert.equal(handOff, undefined);
});

test('a round that passes, or an earlier set, never hands off', async (t) => {
  const passing = await publishRound(t, {
    json: reviewJson({ findings: [finding('p3')] }),
    comments: [summary({ since: opened, count: 5, sha: otherHead })],
  });
  assert.deepEqual(recorded(passing.summaryBody), { since: opened, count: 6, sha });
  assert.doesNotMatch(passing.summaryBody, /Round \d+ of 3/u);
  assert.equal(passing.handOff, undefined);
  assert.deepEqual(passing.drafted, []);

  // A count recorded for a set that began at another time is not this set's.
  const earlier = await publishRound(t, { comments: [summary({ since: '2026-10-01T00:00:00Z', count: 2, sha })] });
  assert.deepEqual(recorded(earlier.summaryBody), { since: opened, count: 1, sha });
});

test('a PR that is already a draft, closed, or past this head is not handed off', async (t) => {
  const stored = { since: opened, count: 2, sha: otherHead };
  for (const options of [{ draft: true }, { state: 'closed' }, { liveHead: otherHead }]) {
    const { handOff, drafted } = await publishRound(t, { comments: [summary(stored)], ...options });
    assert.equal(handOff, undefined, JSON.stringify(options));
    assert.deepEqual(drafted, [], JSON.stringify(options));
  }
});

test('a failed draft conversion only warns, and the comment still asks for a person', async (t) => {
  const { k, handOff } = await publishRound(t, {
    comments: [summary({ since: opened, count: 2, sha: otherHead })],
    failDraft: true,
  });
  assert.deepEqual(k.failures, []);
  assert.match(k.warnings.join('\n'), /Could not move the PR back to draft after 3 rounds/u);
  assert.match(handOff.body, /so the AI review will not review more pushes .* convert it yourself while you decide\./u);
});

test('the hand-off names a human author, and never mentions a bot', async (t) => {
  const stored = { since: opened, count: 2, sha: otherHead };
  for (const [user, ask] of [
    [{ login: 'octo-dev', type: 'User' }, /\n@octo-dev, the AI review/u],
    [{ login: 'kong-volcano-app[bot]', type: 'Bot' }, /\nPR author, the AI review/u],
  ]) {
    const { handOff } = await publishRound(t, { comments: [summary(stored)], author: user });
    assert.match(handOff.body, ask);
    assert.doesNotMatch(handOff.body, /@kong-volcano-app/u);
  }
});

test('an unreadable timeline leaves the PR to the reviews and only warns', async (t) => {
  const { k, summaryBody, handOff, c } = await publishRound(t, {
    comments: [summary({ since: opened, count: 2, sha: otherHead })],
    failTimeline: true,
  });
  assert.deepEqual(k.failures, []);
  assert.match(k.warnings.join('\n'), /Could not count the AI review's rounds/u);
  assert.equal(recorded(summaryBody), null);
  assert.equal(handOff, undefined);
  assert.deepEqual(
    c.set(statusContext).map(([, state]) => state),
    ['failure'],
  );
});
