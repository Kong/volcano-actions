'use strict';

// Sends one review run's spend to an OpenTelemetry collector over OTLP/HTTP
// with JSON encoding: metrics for dashboards and one log record per reviewer
// for looking up a PR. The endpoint and headers follow OpenTelemetry's
// OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS formats.

// `key=value,key=value`, with each value URL-encoded.
function parseHeaders(raw) {
  const headers = {};
  for (const pair of String(raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    headers[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return headers;
}

const value = (v) => {
  if (typeof v === 'boolean') return { boolValue: v };
  if (Number.isInteger(v)) return { intValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  return { stringValue: String(v) };
};
const attributes = (object) =>
  Object.entries(object)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, v]) => ({ key, value: value(v) }));
const nanos = (iso, fallback) => {
  const ms = Date.parse(iso ?? '');
  return `${BigInt(Number.isNaN(ms) ? fallback : ms) * 1_000_000n}`;
};

const tokenTypes = {
  input: 'input',
  output: 'output',
  cacheRead: 'cache_read',
  cacheWrite5m: 'cache_write',
  cacheWrite1h: 'cache_write',
};

// A monotonic delta sum, one data point per reviewer and label set.
const sum = (name, unit, points) => ({
  name,
  unit,
  sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: points },
});

// The attributes a reviewer's metrics carry: few values each, so they stay
// cheap to store. The PR number goes only on the cost, to rank PRs by cost.
const labels = (run, r) => ({
  'vcs.repository.name': run.repo,
  'ai_review.reviewer': r.reviewer,
  'gen_ai.request.model': r.model,
  'ai_review.run.state': r.state,
  'ai_review.run.reason': r.reason,
  'ai_review.cost.basis': r.basis,
});

function metricsOf(run, spend, now) {
  const point = (r, extra, number) => ({
    attributes: attributes({ ...labels(run, r), ...extra }),
    startTimeUnixNano: nanos(r.start, now),
    timeUnixNano: nanos(r.end, now),
    ...number,
  });
  const tokens = spend.flatMap((r) =>
    Object.entries(tokenTypes)
      // Reasoning is part of output, so only the log record reports it.
      .filter(([key]) => r.tokens[key] > 0)
      .map(([key, type]) =>
        point(r, { 'gen_ai.token.type': type, 'ai_review.token.detail': key }, { asInt: String(r.tokens[key]) }),
      ),
  );
  return [
    sum('ai_review.tokens', '{token}', tokens),
    sum(
      'ai_review.cost',
      'USD',
      spend.filter((r) => r.priced).map((r) => point(r, { 'vcs.change.id': run.pr }, { asDouble: r.cost })),
    ),
    sum(
      'ai_review.reviews',
      '{review}',
      spend.map((r) => point(r, {}, { asInt: '1' })),
    ),
    sum(
      'ai_review.unmeasured_calls',
      '{call}',
      spend.map((r) => point(r, {}, { asInt: r.partial ? '1' : '0' })),
    ),
  ];
}

function logsOf(run, spend, now) {
  return spend.map((r) => ({
    timeUnixNano: nanos(r.end, now),
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: `AI review ${r.state} (${r.reason}): ${r.reviewer} spent $${r.cost.toFixed(4)}` },
    attributes: attributes({
      ...labels(run, r),
      'vcs.change.id': run.pr,
      // Logs only: one value per contributor would grow every metric series.
      'github.pr.author': run.author,
      'vcs.ref.head.revision': run.sha,
      'cicd.pipeline.run.id': run.runId,
      'cicd.pipeline.run.attempt': run.attempt,
      'cicd.pipeline.run.url.full': run.url,
      'ai_review.cost.usd': r.cost,
      'ai_review.cost.priced': r.priced,
      'ai_review.cost.known': r.known,
      'ai_review.calls': r.calls,
      'ai_review.usage.recorded': r.recorded,
      'ai_review.usage.partial': r.partial,
      ...Object.fromEntries(Object.entries(r.tokens).map(([key, n]) => [`ai_review.tokens.${key}`, n])),
    }),
  }));
}

const resource = (run) => ({
  attributes: attributes({
    // The `gha-` prefix names CI telemetry, which collectors' sampling rules can keep.
    'service.name': 'gha-ai-review',
    'service.namespace': run.repo,
    // Each run attempt writes its own delta points. OpenTelemetry expects one
    // writer per stream, and runs on different PRs overlap in time.
    'service.instance.id': `${run.repo}/${run.runId}/${run.attempt}`,
    'deployment.environment.name': 'ci',
  }),
});
const scope = { name: 'volcano-actions/ai-review' };

async function post(fetchImpl, endpoint, signal, headers, body) {
  const url = `${endpoint.replace(/\/+$/u, '')}/v1/${signal}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${text.slice(0, 200)}`);
  return rejection(url, text);
}

// A collector can accept a request and still reject part of it, which OTLP
// reports as `partialSuccess` in a successful response. Returns that as a
// message, or null when everything was accepted.
function rejection(url, text) {
  let partial;
  try {
    partial = JSON.parse(text || '{}').partialSuccess;
  } catch {
    return null;
  }
  const rejected = Number(partial?.rejectedDataPoints ?? partial?.rejectedLogRecords ?? 0);
  if (!(rejected > 0) && !partial?.errorMessage) return null;
  return `${url} rejected ${rejected} item(s): ${String(partial.errorMessage ?? '').slice(0, 200)}`;
}

// Sends the metrics and logs. Throws when the collector refuses either, and
// returns what it rejected from requests it accepted; a partly accepted
// request is not sent again, which would repeat the accepted part.
async function exportSpend({ endpoint, headers, run, spend, now = Date.now(), fetchImpl = fetch }) {
  const parsed = parseHeaders(headers);
  const metrics = await post(fetchImpl, endpoint, 'metrics', parsed, {
    resourceMetrics: [{ resource: resource(run), scopeMetrics: [{ scope, metrics: metricsOf(run, spend, now) }] }],
  });
  const logs = await post(fetchImpl, endpoint, 'logs', parsed, {
    resourceLogs: [{ resource: resource(run), scopeLogs: [{ scope, logRecords: logsOf(run, spend, now) }] }],
  });
  return [metrics, logs].filter(Boolean);
}

module.exports = { exportSpend, parseHeaders };
