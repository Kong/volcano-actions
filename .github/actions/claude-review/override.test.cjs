'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { statusContext, humanStatusContext, overrideLabel, override } = require('./claude-review.cjs');
const { sha, review, decided, client, context, core } = require('./test-helpers.cjs');

test('override passes a failing or errored head for writers including the author', async () => {
  for (const state of ['failure', 'error']) {
    for (const permission of ['write', 'admin']) {
      for (const login of ['reviewer', 'author']) {
        const c = client({
          permission,
          statuses: [
            { context: 'other', state: 'success' },
            { context: statusContext, state },
          ],
        });
        const k = core();
        await override({ github: c.github, context: context({ sender: { login, type: 'User' } }), core: k });
        assert.deepEqual(k.failures, [], `${state} ${permission} ${login}`);
        const [status] = c.named('createCommitStatus').filter((s) => s.context === statusContext);
        assert.equal(status.state, 'success');
        assert.equal(status.sha, sha);
        assert.equal(status.description, `Failing verdict overridden by ${login}.`);
        assert.deepEqual(
          c.named('removeLabel').map((l) => l.name),
          [overrideLabel],
        );
      }
    }
  }
});

test('override refuses bots and collaborators without write access including the author', async () => {
  const failing = [{ context: statusContext, state: 'failure' }];
  const cases = [
    [{ permission: 'write' }, { sender: { login: 'dependabot[bot]', type: 'Bot' } }],
    [{ permission: 'read' }, {}],
    [{ permission: 'none' }, {}],
    [{ permission: null }, {}],
    [{ permission: 'triage' }, { sender: { login: 'author', type: 'User' } }],
    [{ permission: 'read' }, { sender: { login: 'author', type: 'User' } }],
    [{ permission: null }, { sender: { login: 'author', type: 'User' } }],
  ];
  for (const [clientOptions, contextOptions] of cases) {
    const c = client({ ...clientOptions, statuses: failing });
    const k = core();
    await override({ github: c.github, context: context(contextOptions), core: k });
    assert.equal(k.failures.length, 1, JSON.stringify([clientOptions, contextOptions]));
    assert.equal(c.named('createCommitStatus').length, 0);
    assert.equal(c.named('removeLabel').length, 1);
  }
});

test('override never stands in for a review that has not failed', async () => {
  for (const statuses of [
    [],
    [{ context: statusContext, state: 'pending' }],
    [{ context: statusContext, state: 'success' }],
    [{ context: 'other', state: 'failure' }],
  ]) {
    for (const login of ['reviewer', 'author']) {
      const c = client({ statuses });
      const k = core();
      await override({ github: c.github, context: context({ sender: { login, type: 'User' } }), core: k });
      assert.equal(k.failures.length, 1, `${JSON.stringify(statuses)} ${login}`);
      assert.match(k.failures[0], /no failing verdict/u);
      assert.equal(c.named('createCommitStatus').length, 0);
    }
  }
});

test('writers including the author can override an unreviewed fork head', async () => {
  for (const headRepo of ['someone/volcano-hosting', null]) {
    for (const permission of ['write', 'admin']) {
      for (const login of ['reviewer', 'author']) {
        const c = client({ permission, headRepo });
        const k = core();
        await override({ github: c.github, context: context({ headRepo, sender: { login, type: 'User' } }), core: k });
        assert.deepEqual(k.failures, [], `${headRepo} ${permission} ${login}`);
        const [status] = c.named('createCommitStatus').filter((s) => s.context === statusContext);
        assert.equal(status.state, 'success');
        assert.equal(status.sha, sha);
        assert.equal(status.description, `Failing verdict overridden by ${login}.`);
        assert.deepEqual(
          c.named('removeLabel').map((l) => l.name),
          [overrideLabel],
        );
      }
    }
  }
});

test('an override also needs a person other than the author', async () => {
  const failing = { context: statusContext, state: 'failure' };
  for (const login of ['author', 'reviewer']) {
    const c = client({ statuses: [failing], comments: [decided([])] });
    await override({ github: c.github, context: context({ sender: { login, type: 'User' } }), core: core() });
    assert.deepEqual(c.set(statusContext), [[sha, 'success', `Failing verdict overridden by ${login}.`]]);
    assert.deepEqual(c.set(humanStatusContext), [
      [sha, 'pending', `Needs human review: Failing verdict overridden by ${login}.`],
    ]);
  }
  // The review's own reasons stay first.
  const both = client({ statuses: [failing], comments: [decided(['Changes billing.'])] });
  await override({
    github: both.github,
    context: context({ sender: { login: 'author', type: 'User' } }),
    core: core(),
  });
  assert.deepEqual(both.set(humanStatusContext), [[sha, 'pending', 'Needs human review: Changes billing.']]);

  const approved = client({ statuses: [failing], comments: [decided([])], reviews: [review('reviewer', 'APPROVED')] });
  await override({
    github: approved.github,
    context: context({ sender: { login: 'author', type: 'User' } }),
    core: core(),
  });
  assert.deepEqual(approved.set(humanStatusContext), [[sha, 'success', 'Approved by reviewer.']]);

  const refused = client({ statuses: [{ context: statusContext, state: 'success' }] });
  await override({ github: refused.github, context: context(), core: core() });
  assert.deepEqual(refused.set(humanStatusContext), []);

  // The human status goes first, so if it fails the verdict still fails.
  const broken = client({ statuses: [failing], comments: [decided([])], failReviews: true });
  await assert.rejects(
    override({ github: broken.github, context: context({ sender: { login: 'author', type: 'User' } }), core: core() }),
    /Server Error/u,
  );
  assert.deepEqual(broken.named('createCommitStatus'), []);
  assert.deepEqual(broken.named('removeLabel'), []);
});
