'use strict';

// Reads the review workflows for the ai-review workflow tests.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { readRepo, root } = require('./test-helpers.cjs');
const { tempDir } = require('./test-git.cjs');

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
const stepsOf = (job) => job.match(/\n {4}steps:(?: &[\w-]+)?\n([\s\S]*)/u)?.[1];
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
// Every job that may report review cost, including comparison reviewers.
const reviewerJobs = (jobs) => Object.keys(jobs).filter((name) => Object.hasOwn(outputsOf(jobs[name]), 'reviewer'));

const modelOf = (job) => job.match(/\n {6}REVIEW_MODEL: (\S+)\n/u)?.[1];

// Use the immutable action the workflow will actually load.
function pinnedCheckout(t) {
  const dir = tempDir(t, 'ai-review-pinned-');
  const archive = path.join(dir, 'pinned.tar');
  execFileSync('git', ['archive', '--output', archive, action.split('@')[1], '.github/actions/ai-review'], {
    cwd: root,
  });
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  return dir;
}

module.exports = {
  reviewWorkflow,
  action,
  jobsOf,
  stepsOf,
  stepText,
  outputsOf,
  reviewerJobs,
  modelOf,
  pinnedCheckout,
};
