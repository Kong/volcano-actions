'use strict';

// The `cost` step: runs once every reviewer job ends, however it ended,
// including when a newer push cancelled the run. In a private repository it
// adds the run's spend to the PR's cost comment and the job log; a public
// repository's PRs and logs are public, so there it shows no dollar figures.
// When the caller passes a collector, it sends the spend as OpenTelemetry
// metrics and logs. Cost is reported beside the review, so nothing here
// fails the job.

const { livePull } = require('./github.cjs');
const { runSpend } = require('./spend.cjs');
const { recordRound, roundOf } = require('./ledger.cjs');
const { exportSpend } = require('./otlp.cjs');
const { runUrl } = require('./constants.cjs');

// Whether the PR has moved past the reviewed head, which is why a cancelled
// review usually stopped. When the PR cannot be read, a cancel counts as `other`.
async function supersededHead(github, context, core) {
  try {
    return (await livePull(github, context)).head.sha !== context.payload.pull_request.head.sha;
  } catch (error) {
    core.warning(`Could not read the PR's head: ${error.message}`);
    return false;
  }
}

// Whether the PR and its run log are visible only inside the organization.
// A payload without the repository counts as public.
const privateRepo = (context) => context.payload.repository?.private === true;

function report(core, spend, showCost) {
  for (const r of spend) {
    core.info(
      `${r.reviewer} (${r.model || 'no model'}): ${r.state}/${r.reason}, ${r.calls} call(s)${showCost ? `, $${r.cost.toFixed(4)}` : ''}`,
    );
    if (!r.recorded) core.warning(`The ${r.reviewer} review recorded no usage, so its cost is unknown.`);
    else if (!r.priced) core.warning(`No price is listed for ${r.model}; its tokens are reported without a cost.`);
  }
}

// `timing` lets tests skip the ledger's waits.
async function cost({ github, context, core, timing }) {
  const superseded = await supersededHead(github, context, core);
  const spend = runSpend(process.env.REVIEWS, process.env.USAGE_OUTPUTS, superseded, context.runAttempt);
  if (spend.length === 0) {
    core.notice('No AI review ran in this attempt, so there is no cost to record.');
    return;
  }
  const shown = privateRepo(context);
  report(core, spend, shown);
  if (!shown) core.info('This repository is public, so the cost goes only to the collector, not to the PR.');
  // The ledger write waits at least `settle` before it re-checks, so the
  // export goes out alongside it rather than after it.
  await Promise.all([shown && record(github, context, core, spend, timing), send(context, core, spend)]);
}

async function record(github, context, core, spend, timing) {
  const key = `${context.runId}/${context.runAttempt}`;
  const round = roundOf(context.payload.pull_request.head.sha, spend, new Date().toISOString());
  try {
    await recordRound({ github, context }, key, round, timing);
  } catch (error) {
    core.warning(`Could not update the PR's AI review cost comment: ${error.message}`);
  }
}

async function send(context, core, spend) {
  const endpoint = process.env.OTLP_ENDPOINT;
  if (!endpoint) return;
  const run = {
    repo: `${context.repo.owner}/${context.repo.repo}`,
    pr: context.payload.pull_request.number,
    author: context.payload.pull_request.user?.login,
    sha: context.payload.pull_request.head.sha,
    runId: context.runId,
    attempt: context.runAttempt,
    url: runUrl(context),
  };
  try {
    const problems = await exportSpend({ endpoint, headers: process.env.OTLP_HEADERS, run, spend });
    for (const message of problems) core.warning(`Could not export all of the AI review cost: ${message}`);
  } catch (error) {
    core.warning(`Could not export the AI review cost: ${error.message}`);
  }
}

module.exports = { cost };
