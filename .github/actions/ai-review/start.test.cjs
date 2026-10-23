'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, start } = require('./ai-review.cjs');
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

const older = '1234567890abcdef';
const review = [{ path: 'Kong/volcano-actions/.github/workflows/ai-review.yml@main', sha: 'abc' }];
// A review run of the caller's review workflow, 77, created before this one.
const run = (id, head, overrides = {}) => ({
  id,
  head_sha: head,
  status: 'in_progress',
  created_at: '2026-10-23T11:00:00Z',
  workflow_id: 77,
  referenced_workflows: review,
  head_repository: { full_name: 'Kong/volcano-hosting' },
  jobs: [
    { name: 'ai-review / start', conclusion: 'success' },
    { name: 'ai-review / override', conclusion: 'skipped' },
  ],
  ...overrides,
});

// A client whose Actions API reports this run (9) as created at noon in
// workflow 77, which calls the review, lists `runs` on the PR's branch, and
// answers each cancel with `cancel`'s [message, status] or success.
function withRuns(options, runs, { cancel = () => null, failRun = false } = {}) {
  const c = client(options);
  // Like an Octokit method, a throw rejects the promise.
  const answer = (call, fn) => (args) =>
    new Promise((resolve) => {
      c.calls.push({ ...args, call });
      resolve(fn(args));
    });
  const fail = ([message, status]) => {
    throw Object.assign(new Error(message), { status });
  };
  c.github.rest.actions = {
    getWorkflowRun: answer('getWorkflowRun', (args) =>
      failRun
        ? fail(['Resource not accessible by integration', 403])
        : {
            data: {
              id: args.run_id,
              workflow_id: 77,
              created_at: '2026-10-23T12:00:00Z',
              referenced_workflows: review,
            },
          },
    ),
    listWorkflowRunsForRepo: answer('listWorkflowRunsForRepo', () => ({ data: { workflow_runs: runs } })),
    listJobsForWorkflowRun: answer('listJobsForWorkflowRun', (args) => ({
      data: { jobs: runs.find((r) => r.id === args.run_id)?.jobs ?? [] },
    })),
    cancelWorkflowRun: answer('cancelWorkflowRun', (args) => (cancel(args) ? fail(cancel(args)) : { data: {} })),
  };
  return c;
}
const cancelled = (c) => c.named('cancelWorkflowRun').map((call) => call.run_id);

test("the live head's review cancels the unfinished review runs of heads the PR has moved past", async () => {
  const c = withRuns({}, [
    run(1, older),
    run(2, older, { status: 'queued' }),
    run(3, older, { status: 'completed' }),
    run(4, sha),
    run(5, older, { created_at: '2026-10-23T12:00:01Z' }),
    run(6, older, { head_repository: { full_name: 'fork/volcano-hosting' } }),
    run(7, older, { status: 'waiting' }),
    // The retarget-and-override stub calls the same review. A run applying
    // the override label removes it as it ends, so it runs to the end.
    run(8, older, { workflow_id: 78 }),
    run(12, older, { workflow_id: 78, jobs: [{ name: 'retarget-or-override / override', conclusion: null }] }),
    // Other workflows on the branch, including the caller's own workflow when
    // a run calls nothing else, and the human gate.
    run(10, older, { workflow_id: 79, referenced_workflows: [] }),
    run(13, older, { referenced_workflows: [] }),
    run(11, older, {
      workflow_id: 80,
      referenced_workflows: [{ path: 'Kong/volcano-actions/.github/workflows/ai-review-human.yml@main' }],
    }),
    run(9, sha),
  ]);
  const k = core();
  await start({ github: c.github, context: context(), core: k });
  assert.deepEqual(k.outputs, { review: 'true' });
  assert.deepEqual(
    c.named('listWorkflowRunsForRepo').map(({ branch, event }) => [branch, event]),
    [['feature', 'pull_request_target']],
  );
  assert.deepEqual(cancelled(c), [1, 2, 7, 8]);
  assert.ok(k.notices.includes('Cancelled run 1, which reviews 1234567, a head this PR has moved past.'));
  // The head is marked under review first.
  const order = c.calls.map((call) => call.call);
  assert.ok(order.lastIndexOf('createCommitStatus') < order.indexOf('getWorkflowRun'));
  assert.deepEqual(k.warnings, []);
});

test("a run never cancels the live head's review", async () => {
  // A stale run skips before it looks at other runs, and so do skipped reviews.
  for (const options of [{ liveHead: older }, { draft: true }, { permission: 'read' }]) {
    const c = withRuns(options, [run(1, older), run(2, sha)]);
    await start({ github: c.github, context: context(), core: core() });
    assert.deepEqual(c.named('getWorkflowRun'), [], JSON.stringify(options));
  }
  // The PR moved on while this run listed the others.
  const heads = [sha, older];
  const moved = withRuns({ liveHead: () => heads.shift() }, [run(1, '1111111111111111')]);
  await start({ github: moved.github, context: context(), core: core() });
  assert.equal(moved.named('getPull').length, 2);
  assert.deepEqual(cancelled(moved), []);
});

test('a failed cancel only warns, and the review goes ahead', async () => {
  const denied = withRuns({}, [run(1, older)], { failRun: true });
  const d = core();
  await start({ github: denied.github, context: context(), core: d });
  assert.deepEqual(d.outputs, { review: 'true' });
  assert.equal(denied.named('createCommitStatus').length, 2);
  assert.deepEqual(d.warnings, [
    'Could not cancel the reviews of heads this PR has moved past: Resource not accessible by integration',
  ]);

  const runs = [run(1, older), run(2, older), run(3, older)];
  const rejections = { 1: ['Cannot cancel a workflow run that is completed.', 409], 2: ['Server Error', 500] };
  const partial = withRuns({}, runs, { cancel: (args) => rejections[args.run_id] });
  const p = core();
  await start({ github: partial.github, context: context(), core: p });
  assert.deepEqual(cancelled(partial), [1, 2, 3]);
  assert.deepEqual(p.warnings, ['Could not cancel run 2: Server Error']);
  assert.ok(p.notices.includes('Cancelled run 3, which reviews 1234567, a head this PR has moved past.'));
});

// Cancelling a review leaves its head pending. If the PR returns to that head
// while closed, its reopen must review it rather than wait on nothing.
test('a reopen reviews a head whose pending verdict no run is still working on', async () => {
  const pending = { statuses: [{ context: statusContext, state: 'pending' }] };
  const reopen = async (c) => {
    const k = core();
    await start({ github: c.github, context: context({ action: 'reopened' }), core: k });
    return k.outputs.review;
  };
  assert.equal(await reopen(withRuns(pending, [run(1, older)])), 'true');
  assert.equal(await reopen(withRuns(pending, [run(1, sha)])), 'false');
  // A run that has not listed its jobs yet may still review the head.
  assert.equal(await reopen(withRuns(pending, [run(1, sha, { jobs: [] })])), 'false');
  // An override of the head reviews nothing.
  const override = [
    { name: 'retarget-or-override / start', conclusion: 'skipped' },
    { name: 'retarget-or-override / override', conclusion: null },
  ];
  assert.equal(await reopen(withRuns(pending, [run(1, sha, { workflow_id: 78, jobs: override })])), 'true');
  assert.equal(await reopen(withRuns(pending, [], { failRun: true })), 'false');
  assert.equal(await reopen(withRuns({ statuses: [{ context: statusContext, state: 'failure' }] }, [])), 'false');
});
