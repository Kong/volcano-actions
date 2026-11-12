'use strict';

// The `cost` step: runs once every reviewer job ends, however it ended,
// including when a newer push cancelled the run. It adds the run's spend to
// the PR's cost comment and, when the caller passes a collector, sends it as
// OpenTelemetry metrics and logs. Cost is reported beside the review, so
// nothing here fails the job.

const { livePull } = require('./github.cjs');
const { runSpend } = require('./spend.cjs');
const { recordRound, roundOf } = require('./ledger.cjs');
const { exportSpend } = require('./otlp.cjs');
const { runUrl } = require('./constants.cjs');

// Whether the PR has moved past the reviewed head, which is why a cancelled
// review usually stopped. When the PR cannot be read, a cancel counts as manual.
async function supersededHead(github, context, core) {
  try {
    return (await livePull(github, context)).head.sha !== context.payload.pull_request.head.sha;
  } catch (error) {
    core.warning(`Could not read the PR's head: ${error.message}`);
    return false;
  }
}

function report(core, spend) {
  for (const r of spend) {
    core.info(
      `${r.reviewer} (${r.model || 'no model'}): ${r.state}/${r.reason}, ${r.calls} call(s), $${r.cost.toFixed(4)}`,
    );
    if (!r.recorded) core.warning(`The ${r.reviewer} review recorded no usage, so its cost is unknown.`);
    else if (!r.priced) core.warning(`No price is listed for ${r.model}; its tokens are reported without a cost.`);
  }
}

// `timing` lets tests skip the ledger's waits.
async function cost({ github, context, core, timing }) {
  const pr = context.payload.pull_request;
  const superseded = await supersededHead(github, context, core);
  const spend = runSpend(process.env.REVIEWS, process.env.USAGE_OUTPUTS, superseded, context.runAttempt);
  if (spend.length === 0) {
    core.notice('No AI review ran in this attempt, so there is no cost to record.');
    return;
  }
  report(core, spend);
  const key = `${context.runId}/${context.runAttempt}`;
  try {
    await recordRound({ github, context }, key, roundOf(pr.head.sha, spend, new Date().toISOString()), timing);
  } catch (error) {
    core.warning(`Could not update the PR's AI review cost comment: ${error.message}`);
  }
  const endpoint = process.env.OTLP_ENDPOINT;
  if (!endpoint) return;
  const run = {
    repo: `${context.repo.owner}/${context.repo.repo}`,
    pr: pr.number,
    runId: context.runId,
    attempt: context.runAttempt,
    url: runUrl(context),
  };
  try {
    const rejected = await exportSpend({ endpoint, headers: process.env.OTLP_HEADERS, run, spend });
    for (const message of rejected) core.warning(`The collector rejected part of the AI review cost: ${message}`);
  } catch (error) {
    core.warning(`Could not export the AI review cost: ${error.message}`);
  }
}

module.exports = { cost };
