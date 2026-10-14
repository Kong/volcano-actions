'use strict';

// Fake model providers for the merge tests. Nothing here reaches the network.

const { clearAfter } = require('./test-helpers.cjs');

const anthropicKey = 'sk-ant-test-key';
const openaiKey = 'sk-openai-test-key';

// Sets the merge keys for one test; an empty one stays unset.
function setKeys(t, { anthropic = '', openai = '' } = {}) {
  clearAfter(t, 'AI_REVIEW_ANTHROPIC_API_KEY', 'AI_REVIEW_OPENAI_API_KEY');
  for (const [name, key] of [
    ['AI_REVIEW_ANTHROPIC_API_KEY', anthropic],
    ['AI_REVIEW_OPENAI_API_KEY', openai],
  ]) {
    if (key) process.env[name] = key;
    else delete process.env[name];
  }
}

// A merged review in schema.json's shape.
const mergedReview = ({
  summary = 'Adds a cache for lookups.',
  findings = [],
  reasons = [],
  notChecked = [],
  needed = reasons.length > 0,
} = {}) => ({
  summary,
  findings,
  human_review: { needed, reasons, reviewer: '', reviewer_reason: '' },
  not_checked: notChecked,
  reviewed_closely: true,
});

const reply = (status, body) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
// Each provider's successful answer carrying this review.
const fromAnthropic = (review) =>
  reply(200, { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'merged_review', input: review }] });
const fromOpenai = (review) =>
  reply(200, {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(review) }] }],
  });
// Never answers; rejects once the caller aborts.
const hang = (url, init) =>
  new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });

// Answers each fetch with the next answer, a Response or a function of the
// request, and records every request with its body parsed.
function fakeFetch(t, ...answers) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected fetch of ${url}`);
    return typeof next === 'function' ? next(url, init) : Promise.resolve(next);
  });
  return calls;
}

module.exports = {
  anthropicKey,
  openaiKey,
  setKeys,
  mergedReview,
  reply,
  fromAnthropic,
  fromOpenai,
  hang,
  fakeFetch,
};
