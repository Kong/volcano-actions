'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { usage, claudeUsage, codexUsage } = require('./usage.cjs');
const { tempDir } = require('./test-git.cjs');
const { prices } = require('./prices.cjs');
const { reviewWorkflow, jobsOf, outputsOf, reviewerJobs } = require('./test-workflow.cjs');
const { clearAfter, core } = require('./test-helpers.cjs');

const jsonl = (...records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// One line of a Claude Code session log for a content block of response `id`.
const claudeLine = (id, usage, timestamp = '2026-11-11T10:00:00Z', model = 'claude-opus-5-5') => ({
  type: 'assistant',
  timestamp,
  message: { id, model, usage },
});
const claudeCall = {
  input_tokens: 10,
  output_tokens: 200,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 3000,
  cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 2000 },
  output_tokens_details: { thinking_tokens: 50 },
};

// A Codex running total after a model call.
const tokenCount = (input, cached, output, reasoning, timestamp = '2026-11-11T10:00:00Z') => ({
  type: 'event_msg',
  timestamp,
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
    },
  },
});

test('Claude usage counts each response once, by model, with its cache writes split by lifetime', (t) => {
  const dir = tempDir(t, 'claude-projects-');
  write(
    path.join(dir, 'proj', 'session.jsonl'),
    jsonl(
      { type: 'user', message: { content: 'review' } },
      claudeLine('msg_1', claudeCall, '2026-11-11T10:00:00Z'),
      // A second content block of the same response repeats its usage.
      claudeLine('msg_1', claudeCall, '2026-11-11T10:00:01Z'),
      claudeLine('msg_2', { input_tokens: 1, output_tokens: 7, cache_read_input_tokens: 8000 }, '2026-11-11T10:05:00Z'),
      // A placeholder Claude Code writes for an API error, which no model produced.
      claudeLine('msg_err', { input_tokens: 0, output_tokens: 0 }, '2026-11-11T10:06:00Z', '<synthetic>'),
      // The last line was cut off when the job stopped.
    ) + '{"type":"assistant","message":{"id":"msg_3"',
  );
  const result = claudeUsage(dir);
  assert.deepEqual(result.models, {
    'claude-opus-5-5': {
      calls: 2,
      tokens: { input: 11, output: 207, cacheRead: 13000, cacheWrite5m: 2000, cacheWrite1h: 1000, reasoning: 50 },
    },
  });
  assert.equal(result.start, '2026-11-11T10:00:00Z');
  assert.equal(result.end, '2026-11-11T10:05:00Z');
});

test('Codex usage takes the last running total and counts a call per changed total', (t) => {
  const dir = tempDir(t, 'codex-sessions-');
  write(
    path.join(dir, '2026', '11', '11', 'rollout-a.jsonl'),
    jsonl(
      { type: 'session_meta', payload: {} },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      tokenCount(20000, 13000, 85, 10, '2026-11-11T10:00:00Z'),
      // A rate-limit update repeats the total.
      tokenCount(20000, 13000, 85, 10, '2026-11-11T10:00:01Z'),
      tokenCount(44000, 33000, 338, 40, '2026-11-11T10:02:00Z'),
    ),
  );
  const result = codexUsage(dir, 'fallback');
  assert.deepEqual(result.models, {
    'gpt-6.1-sol': {
      calls: 2,
      tokens: { input: 11000, output: 338, cacheRead: 33000, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 40 },
    },
  });
  assert.equal(result.end, '2026-11-11T10:02:00Z');
  // Without a turn context, the job's model names it.
  write(path.join(dir, 'b', 'rollout-b.jsonl'), jsonl(tokenCount(100, 0, 1, 0)));
  assert.equal(codexUsage(dir, 'fallback').models.fallback.calls, 1);
});

test('the usage step writes the totals, and only the totals, for the job to upload', (t) => {
  const home = tempDir(t, 'home-');
  const out = path.join(tempDir(t, 'out-'), 'ai-review-usage-claude.json');
  write(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), jsonl(claudeLine('msg_1', claudeCall)));
  const previous = process.env.HOME;
  t.after(() => {
    process.env.HOME = previous;
  });
  process.env.HOME = home;
  // A developer's own Claude Code settings must not point the test at their logs.
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  clearAfter(t, 'CLAUDE_CONFIG_DIR');
  Object.assign(process.env, { PROVIDER: 'claude', USAGE_FILE: out, GITHUB_RUN_ATTEMPT: '2' });
  clearAfter(t, 'PROVIDER', 'USAGE_FILE', 'GITHUB_RUN_ATTEMPT');
  const k = core();
  usage({ core: k });
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.provider, 'claude');
  assert.equal(written.attempt, 2);
  assert.equal(written.models['claude-opus-5-5'].calls, 1);
  assert.deepEqual(Object.keys(written).toSorted(), ['attempt', 'end', 'models', 'provider', 'start']);
  assert.deepEqual(k.warnings, []);
});

test('the usage step records no models, with a warning, when the session log is missing', (t) => {
  const out = path.join(tempDir(t, 'out-'), 'ai-review-usage-codex.json');
  Object.assign(process.env, {
    PROVIDER: 'codex',
    USAGE_FILE: out,
    CODEX_HOME: tempDir(t, 'codex-home-'),
    GITHUB_RUN_ATTEMPT: '1',
  });
  clearAfter(t, 'PROVIDER', 'USAGE_FILE', 'CODEX_HOME', 'GITHUB_RUN_ATTEMPT');
  const k = core();
  usage({ core: k });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { provider: 'codex', attempt: 1, models: {} });
  assert.match(k.warnings[0], /No codex usage was recorded/u);
});

test('every reviewer job names a model the price table lists', () => {
  const jobs = jobsOf(reviewWorkflow());
  const models = reviewerJobs(jobs).map((name) => outputsOf(jobs[name]).model);
  assert.ok(models.length > 0);
  for (const model of models) assert.ok(Object.hasOwn(prices, model), `${model} has no price in prices.cjs`);
});
