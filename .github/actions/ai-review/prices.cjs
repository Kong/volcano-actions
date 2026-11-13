'use strict';

// List prices in US dollars per million tokens, for the models the reviewer
// jobs name. A model missing here reports its tokens with no cost. Update the
// table with the model a reviewer job names.
//
// `basis` says what the price stands for: `api` when the reviewer is billed
// per token at these prices, `list_price_equivalent` when it runs on a plan
// with no per-token bill, as Codex does on a ChatGPT workspace token.
const prices = {
  // https://platform.claude.com/docs/en/about-claude/pricing
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, basis: 'api' },
  // https://openai.com/index/introducing-gpt-6-1-sol/
  'gpt-6.1-sol': {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite5m: 2,
    cacheWrite1h: 2,
    basis: 'list_price_equivalent',
  },
};

// The cost of one model's tokens, or null when the table has no price for it.
function costOf(model, tokens) {
  const price = prices[model];
  if (!price) return null;
  const dollars =
    (tokens.input ?? 0) * price.input +
    (tokens.output ?? 0) * price.output +
    (tokens.cacheRead ?? 0) * price.cacheRead +
    (tokens.cacheWrite5m ?? 0) * price.cacheWrite5m +
    (tokens.cacheWrite1h ?? 0) * price.cacheWrite1h;
  return dollars / 1e6;
}

const basisOf = (model) => prices[model]?.basis ?? 'unknown';

module.exports = { prices, costOf, basisOf };
