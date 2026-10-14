'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, start } = require('./claude-review.cjs');
const { sha, client, context, core } = require('./test-helpers.cjs');

test('start marks the live head pending for writers and allowed bots', async () => {
  for (const [actor, permission] of [
    ['author', 'write'],
    ['admin', 'admin'],
    ['dependabot[bot]', null],
  ]) {
    const c = client({ permission });
    const k = core();
    await start({ github: c.github, context: context({ actor }), core: k });
    assert.deepEqual(
      c.named('createCommitStatus').map((s) => [s.sha, s.state, s.context]),
      [
        [sha, 'pending', statusContext],
        [sha, 'pending', humanStatusContext],
      ],
      actor,
    );
    assert.deepEqual(k.outputs, { review: 'true' });
  }
});

test('a reopen reviews only a head with no verdict yet', async () => {
  for (const state of ['pending', 'success', 'failure', 'error']) {
    const c = client({ statuses: [{ context: statusContext, state }] });
    const k = core();
    await start({ github: c.github, context: context({ action: 'reopened' }), core: k });
    assert.equal(c.named('createCommitStatus').length, 0, state);
    assert.deepEqual(k.outputs, { review: 'false' });
  }
  const fresh = client({ statuses: [{ context: 'other', state: 'success' }] });
  const k = core();
  await start({ github: fresh.github, context: context({ action: 'reopened' }), core: k });
  assert.deepEqual(k.outputs, { review: 'true' });

  const push = client({ statuses: [{ context: statusContext, state: 'success' }] });
  const p = core();
  await start({ github: push.github, context: context(), core: p });
  assert.deepEqual(p.outputs, { review: 'true' });

  // Re-running a failed reopen review must review again, not find its own error.
  for (const state of ['error', 'pending']) {
    const rerun = client({ statuses: [{ context: statusContext, state }] });
    const r = core();
    await start({ github: rerun.github, context: context({ action: 'reopened', runAttempt: 2 }), core: r });
    assert.deepEqual(r.outputs, { review: 'true' }, state);
  }
});

test('start skips a stale head or base and an actor the action would refuse', async () => {
  for (const [options, actor] of [
    [{ liveHead: 'fedcba9876543210' }, 'author'],
    [{ liveBase: 'release' }, 'author'],
    [{ permission: 'read' }, 'triager'],
    [{ permission: null }, 'stranger'],
  ]) {
    const c = client(options);
    const k = core();
    await start({ github: c.github, context: context({ actor }), core: k });
    assert.equal(c.named('createCommitStatus').length, 0, actor);
    assert.deepEqual(k.outputs, { review: 'false' });
  }
});

// A push followed at once by ready_for_review can deliver a synchronize
// payload that still says draft, alongside a ready_for_review payload for the
// old head. Only the live PR decides.
test('start decides draft by the live PR, not the payload', async () => {
  for (const action of ['opened', 'synchronize', 'ready_for_review', 'reopened', 'edited']) {
    const stale = client();
    const k = core();
    await start({ github: stale.github, context: context({ action, draft: true }), core: k });
    assert.deepEqual(k.outputs, { review: 'true' }, action);
    assert.deepEqual(
      stale.named('createCommitStatus').map((s) => [s.sha, s.state]),
      [
        [sha, 'pending'],
        [sha, 'pending'],
      ],
      action,
    );
    assert.equal(stale.named('getPull').length, 1, action);

    for (const payloadDraft of [false, true]) {
      const live = client({ draft: true });
      const d = core();
      await start({ github: live.github, context: context({ action, draft: payloadDraft }), core: d });
      assert.deepEqual(d.outputs, { review: 'false' }, `${action} ${payloadDraft}`);
      assert.equal(live.named('createCommitStatus').length, 0, `${action} ${payloadDraft}`);
    }
  }
});
