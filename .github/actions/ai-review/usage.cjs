'use strict';

// Reads what one reviewer spent from the session log its CLI writes as it
// runs, and writes the totals to a file the job uploads. The log grows after
// every model call, so a review that is cancelled or times out still reports
// what it spent up to its last completed call. Only the totals leave the
// runner: the log holds everything the reviewer read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every file under `dir` whose name matches, however deep.
function filesUnder(dir, match) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, match);
    return entry.isFile() && match.test(entry.name) ? [full] : [];
  });
}

// A JSONL file's records, skipping lines that do not parse, such as a last
// line cut off when the job stopped.
function records(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
}

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 });

function addTokens(into, tokens) {
  for (const key of Object.keys(into)) into[key] += count(tokens[key]);
  return into;
}

// The first and last timestamps the records carry, as ISO strings.
function spanOf(times) {
  const valid = times.filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t))).toSorted();
  return valid.length > 0 ? { start: valid[0], end: valid.at(-1) } : {};
}

// Claude Code writes one line per content block of a response, each carrying
// the response's usage, so a response counts once by its message ID.
// `input_tokens` excludes cache reads and writes.
function claudeTokens(usage) {
  const writes = count(usage.cache_creation_input_tokens);
  const oneHour = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m: writes - Math.min(oneHour, writes),
    cacheWrite1h: Math.min(oneHour, writes),
    reasoning: count(usage.output_tokens_details?.thinking_tokens),
  };
}

// Claude Code's session logs under `dir`, by model.
function claudeUsage(dir) {
  const responses = new Map();
  const times = [];
  for (const file of filesUnder(dir, /\.jsonl$/u)) {
    for (const record of records(file)) {
      const message = record?.message;
      if (record?.type !== 'assistant' || !message?.id || !message.usage) continue;
      // Claude Code writes placeholders, such as for an API error, that no model produced.
      if (message.model === '<synthetic>') continue;
      responses.set(message.id, { model: String(message.model ?? 'unknown'), tokens: claudeTokens(message.usage) });
      times.push(record.timestamp);
    }
  }
  const models = {};
  for (const { model, tokens } of responses.values()) {
    models[model] ??= { calls: 0, tokens: emptyTokens() };
    models[model].calls += 1;
    addTokens(models[model].tokens, tokens);
  }
  return { models, ...spanOf(times) };
}

// Codex records its running total after each model call. OpenAI's
// `input_tokens` includes cached input, and `output_tokens` includes
// reasoning.
function codexTokens(total) {
  const cached = count(total.cached_input_tokens);
  return {
    input: Math.max(count(total.input_tokens) - cached, 0),
    output: count(total.output_tokens),
    cacheRead: cached,
    cacheWrite5m: count(total.cache_write_input_tokens),
    cacheWrite1h: 0,
    reasoning: count(total.reasoning_output_tokens),
  };
}

// One Codex session log: its last running total, the number of model calls
// that total covers, and the model its turn context names.
function codexSession(file, fallbackModel) {
  let total = null;
  let calls = 0;
  let model = fallbackModel;
  const times = [];
  for (const record of records(file)) {
    const payload = record?.payload;
    if (record?.type === 'turn_context' && typeof payload?.model === 'string') model = payload.model;
    if (record?.type !== 'event_msg' || payload?.type !== 'token_count' || !payload.info?.total_token_usage) continue;
    // A rate-limit update repeats the last total; only a changed total is a call.
    if (payload.info.total_token_usage.total_tokens === total?.total_tokens) continue;
    total = payload.info.total_token_usage;
    calls += 1;
    times.push(record.timestamp);
  }
  return total && { model, calls, tokens: codexTokens(total), times };
}

// Codex's session logs under `dir`, by model.
function codexUsage(dir, fallbackModel) {
  const models = {};
  const times = [];
  for (const file of filesUnder(dir, /^rollout-.*\.jsonl$/u)) {
    const session = codexSession(file, fallbackModel);
    if (!session) continue;
    models[session.model] ??= { calls: 0, tokens: emptyTokens() };
    models[session.model].calls += session.calls;
    addTokens(models[session.model].tokens, session.tokens);
    times.push(...session.times);
  }
  return { models, ...spanOf(times) };
}

const home = () => process.env.HOME || os.homedir();
const readers = {
  claude: () => claudeUsage(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude'), 'projects')),
  codex: (model) => codexUsage(path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'sessions'), model),
};

// The `usage` step: runs in a reviewer job after its provider, whatever the
// provider's outcome, and writes { provider, attempt, models, start, end } to
// USAGE_FILE. The run attempt lets the cost step skip usage a re-run carried
// over from an earlier attempt. A missing log writes no models; nothing here
// fails the job.
function usage({ core }) {
  const provider = process.env.PROVIDER;
  const read = readers[provider];
  if (!read) throw new Error(`Unknown AI review provider: ${provider}`);
  let result = { models: {} };
  try {
    result = read(process.env.MODEL);
  } catch (error) {
    core.warning(`Could not read the ${provider} session log: ${error.message}`);
  }
  if (Object.keys(result.models).length === 0) core.warning(`No ${provider} usage was recorded.`);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT) || 1;
  fs.writeFileSync(process.env.USAGE_FILE, JSON.stringify({ provider, attempt, ...result }));
}

module.exports = { usage, claudeUsage, codexUsage, emptyTokens, addTokens };
