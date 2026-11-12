'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cost } = require('./cost.cjs');
const { runSpend } = require('./spend.cjs');
const { ledgerOf, costBody, roundOf } = require('./ledger.cjs');
const { exportSpend, parseHeaders } = require('./otlp.cjs');
const { tempDir } = require('./test-git.cjs');
const { sha, clearAfter, context, core } = require('./test-helpers.cjs');
const {
  tokens,
  claudeUsage,
  codexUsage,
  needs,
  usageDir,
  resolved,
  commentsClient,
  noWait,
} = require('./test-cost.cjs');

test('spend prices each reviewer and says how its run ended', (t) => {
  const dir = usageDir(t);
  const [claude, codex] = runSpend(needs('success'), dir, false);
  // 1M input at $4, 100k output at $20, 2M cache reads at $0.20.
  assert.equal(claude.cost.toFixed(2), '6.40');
  assert.deepEqual(
    [claude.state, claude.reason, claude.partial, claude.basis],
    ['finished', 'completed', false, 'api'],
  );
  assert.equal(codex.cost.toFixed(2), '3.00');
  assert.equal(codex.basis, 'list_price_equivalent');

  const [cancelled] = runSpend(needs('cancelled'), dir, true);
  assert.deepEqual([cancelled.state, cancelled.reason, cancelled.partial], ['cancelled', 'superseded', true]);
  assert.equal(runSpend(needs('cancelled'), dir, false)[0].reason, 'manual');
  assert.equal(runSpend(needs('failure'), dir, false)[0].reason, 'failed');
});

test('spend skips skipped reviewers and jobs that are not reviewers, and flags missing usage', (t) => {
  const dir = usageDir(t, { codex: codexUsage });
  const spend = runSpend(needs('cancelled', 'skipped', { verdict: { result: 'skipped', outputs: {} } }), dir, true);
  assert.deepEqual(
    spend.map((r) => [r.reviewer, r.recorded, r.cost]),
    [['Claude', false, 0]],
  );
  assert.deepEqual(
    runSpend(needs('skipped'), dir, false).map((r) => r.reviewer),
    [],
  );
});

test('an unknown cost shows as ? and makes the totals a lower bound', (t) => {
  const unpriced = { provider: 'claude', attempt: 1, models: { 'claude-next': { calls: 1, tokens: tokens(10, 10) } } };
  const spend = runSpend(needs('success'), usageDir(t, { claude: unpriced }), false);
  assert.deepEqual(
    spend.map((r) => [r.reviewer, r.known, r.partial]),
    [
      ['Claude', false, false],
      ['Codex', false, false],
    ],
  );
  const ledger = ledgerOf(null);
  ledger.rounds['9/1'] = roundOf(sha, spend, '2026-11-11T10:00:00Z');
  const body = costBody(ledger);
  assert.match(body, /\*\*AI review cost:\*\* ~\$0\.00 over 1 round/u);
  assert.match(body, /\| `abcdef1` \| finished \| \? \| \? \| ~\$0\.00 \|/u);
});

test('a re-run records only the reviewers it ran, not those carried over from an earlier attempt', (t) => {
  const dir = usageDir(t, { claude: claudeUsage, codex: { ...codexUsage, attempt: 2 } });
  assert.deepEqual(
    runSpend(needs('success'), dir, false, 2).map((r) => r.reviewer),
    ['Codex'],
  );
  // Re-running only the verdict or cost job records nothing again.
  assert.deepEqual(runSpend(needs('success'), usageDir(t), false, 2), []);
  // Without a usage file, only a first attempt can tell the reviewer ran.
  assert.deepEqual(
    runSpend(needs('cancelled'), tempDir(t, 'usage-'), true, 1).map((r) => r.reviewer),
    ['Claude', 'Codex'],
  );
  assert.deepEqual(runSpend(needs('cancelled'), tempDir(t, 'usage-'), true, 2), []);
});

test('OTLP headers parse as OpenTelemetry writes them', () => {
  assert.deepEqual(parseHeaders('Authorization=Bearer abc=,Dash0-Dataset=volcano, x = a%20b ,bad'), {
    Authorization: 'Bearer abc=',
    'Dash0-Dataset': 'volcano',
    x: 'a b',
  });
});

test('the export sends metrics and logs with the run and each reviewer', async (t) => {
  const sent = [];
  const fetchImpl = resolved((url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true };
  });
  const run = { repo: 'Kong/volcano-hosting', pr: 7, author: 'author', sha, runId: 9, attempt: 1, url: 'u' };
  const spend = runSpend(needs('success', 'cancelled'), usageDir(t), true);
  await exportSpend({ endpoint: 'https://otlp.example/', headers: 'Authorization=Bearer t', run, spend, fetchImpl });
  assert.deepEqual(
    sent.map((s) => s.url),
    ['https://otlp.example/v1/metrics', 'https://otlp.example/v1/logs'],
  );
  assert.equal(sent[0].headers.Authorization, 'Bearer t');
  const metrics = sent[0].body.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.deepEqual(
    metrics.map((m) => m.name),
    ['ai_review.tokens', 'ai_review.cost', 'ai_review.reviews', 'ai_review.unmeasured_calls'],
  );
  const costPoints = metrics[1].sum.dataPoints;
  const attrs = (p) => Object.fromEntries(p.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.deepEqual(
    costPoints.map((p) => [attrs(p)['ai_review.reviewer'], attrs(p)['ai_review.run.state'], p.asDouble.toFixed(2)]),
    [
      ['Claude', 'finished', '6.40'],
      ['Codex', 'cancelled', '3.00'],
    ],
  );
  assert.equal(attrs(costPoints[0])['vcs.change.id'], '7');
  const logs = sent[1].body.resourceLogs[0];
  assert.equal(logs.scopeLogs[0].logRecords.length, 2);
  for (const record of logs.scopeLogs[0].logRecords) assert.equal(attrs(record)['github.pr.author'], 'author');
  // Metrics carry no author, so their series stay few.
  for (const metric of metrics) {
    for (const point of metric.sum.dataPoints) assert.ok(!('github.pr.author' in attrs(point)), metric.name);
  }
  assert.ok(logs.resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'gha-ai-review'));
});

test('the cost step records the round and exports it, and a refused export only warns', async (t) => {
  const dir = usageDir(t);
  Object.assign(process.env, { REVIEWS: needs('cancelled'), USAGE_OUTPUTS: dir, OTLP_ENDPOINT: 'http://127.0.0.1:9' });
  clearAfter(t, 'REVIEWS', 'USAGE_OUTPUTS', 'OTLP_ENDPOINT');
  const c = commentsClient();
  const k = core();
  // Port 9 refuses the connection.
  await cost({ github: c.github, context: context(), core: k, timing: noWait });
  const [comment] = c.comments();
  const ledger = ledgerOf(comment);
  // The live head moved past the reviewed one, so the cancel was a push.
  assert.equal(ledger.rounds['9/1'].state, 'cancelled');
  assert.match(comment.body, /- Cancelled: ~\$9\.40 \(1 round\)/u);
  assert.equal(k.failures.length, 0);
  assert.match(k.warnings.at(-1), /Could not export the AI review cost/u);
});

test('the cost step records nothing when no review ran', async (t) => {
  Object.assign(process.env, { REVIEWS: needs('skipped'), USAGE_OUTPUTS: tempDir(t, 'usage-') });
  clearAfter(t, 'REVIEWS', 'USAGE_OUTPUTS');
  const c = commentsClient();
  const k = core();
  await cost({ github: c.github, context: context(), core: k, timing: noWait });
  assert.deepEqual(c.calls, []);
  assert.match(k.notices[0], /No AI review ran/u);
});
