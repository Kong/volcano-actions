'use strict';

// Reads the review workflows for the ai-review workflow tests.

const { readRepo } = require('./test-helpers.cjs');

const reviewWorkflow = () => readRepo('.github/workflows/ai-review.yml');
// The pinned action every job of the review workflows runs.
const action = reviewWorkflow().match(/uses: (Kong\/volcano-actions\/\.github\/actions\/ai-review@\S+)/u)[1];

const jobsOf = (workflow) =>
  Object.fromEntries(
    workflow
      .split('\njobs:\n')[1]
      .split(/\n(?= {2}[a-z-]+:\n)/u)
      .map((job) => [job.match(/^ {2}([a-z-]+):/u)[1], job]),
  );
const stepsOf = (job) => job.split('\n    steps:\n')[1];
// The text of a step from its first line to the next step or comment above one.
const stepText = (job, marker) => {
  const body = stepsOf(job);
  const from = body.indexOf(marker);
  if (from === -1) return '';
  const next = body.slice(from + 1).search(/\n {6}[-#]/u);
  return body.slice(from, next === -1 ? undefined : from + 1 + next);
};
// A job's outputs, as { name: value }.
const outputsOf = (job) => {
  const block = job.match(/\n {4}outputs:\n((?: {6}.*\n)+)/u)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/^ {6}([a-z-]+): (.*)$/gmu)].map(([, name, value]) => [name, value]));
};
// The jobs the verdict combines: those with a reviewer output.
const reviewerJobs = (jobs) => Object.keys(jobs).filter((name) => Object.hasOwn(outputsOf(jobs[name]), 'reviewer'));

module.exports = { reviewWorkflow, action, jobsOf, stepsOf, stepText, outputsOf, reviewerJobs };
