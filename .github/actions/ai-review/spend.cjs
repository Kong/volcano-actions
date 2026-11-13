'use strict';

// What one review run spent, reviewer by reviewer, from the usage files the
// reviewer jobs upload and the jobs' results.

const fs = require('node:fs');
const path = require('node:path');
const { costOf, basisOf } = require('./prices.cjs');
const { emptyTokens, addTokens } = require('./usage.cjs');

// A reviewer job's usage file, `ai-review-usage-<job ID>.json` in `dir`, or
// null when the job uploaded none.
function usageOf(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `ai-review-usage-${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Whether a run that stopped early was superseded by a newer head, or
// stopped for another reason: a person cancelling it, a retarget cancelling
// the same head's review, or a job timeout. Which of those is not known.
const stateOf = (result, superseded) => {
  if (result === 'success') return { state: 'finished', reason: 'completed' };
  if (result === 'failure') return { state: 'finished', reason: 'failed' };
  return { state: 'cancelled', reason: superseded ? 'superseded' : 'other' };
};

// One reviewer's spend. A review that did not complete may have had a model
// call in flight when it stopped, which no log records, so its cost is a
// lower bound.
function reviewerSpend(id, job, usage, superseded) {
  const models = Object.entries(usage?.models ?? {});
  const tokens = emptyTokens();
  let cost = 0;
  let priced = models.length > 0;
  for (const [model, entry] of models) {
    addTokens(tokens, entry.tokens);
    const dollars = costOf(model, entry.tokens);
    if (dollars === null) priced = false;
    cost += dollars ?? 0;
  }
  const model = models.map(([name]) => name).join(',') || job.outputs?.model || '';
  return {
    job: id,
    reviewer: job.outputs?.reviewer || `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
    model,
    basis: models.length > 0 ? basisOf(models[0][0]) : 'unknown',
    ...stateOf(job.result, superseded),
    calls: models.reduce((sum, [, entry]) => sum + (entry.calls ?? 0), 0),
    tokens,
    cost,
    priced,
    recorded: usage !== null,
    // A cost the comment cannot state exactly: no usage was recorded, or a
    // model has no price.
    known: usage !== null && priced,
    partial: job.result !== 'success',
    start: usage?.start,
    end: usage?.end,
  };
}

// Whether this attempt ran the reviewer. Re-running failed jobs keeps the
// other jobs' results and artifacts from the earlier attempt, whose cost step
// already recorded them. Without a usage file, only a first attempt can tell.
const ranIn = (usage, attempt) => (usage ? (usage.attempt ?? attempt) === attempt : attempt === 1);

// Every reviewer in the cost job's `needs` that ran in this attempt. A
// reviewer is a job with a usage file or a `reviewer` output; any other job in
// `needs`, such as the verdict, is not one. Skipped reviewers spent nothing.
function runSpend(raw, dir, superseded, attempt = 1) {
  let needs;
  try {
    needs = JSON.parse(raw || '{}');
  } catch {
    needs = {};
  }
  const jobs = needs && typeof needs === 'object' && !Array.isArray(needs) ? Object.entries(needs) : [];
  return jobs.flatMap(([id, job]) => {
    if (!job || typeof job !== 'object' || job.result === 'skipped') return [];
    const usage = dir ? usageOf(dir, id) : null;
    if ((!usage && !job.outputs?.reviewer) || !ranIn(usage, attempt)) return [];
    return [reviewerSpend(id, job, usage, superseded)];
  });
}

module.exports = { runSpend };
