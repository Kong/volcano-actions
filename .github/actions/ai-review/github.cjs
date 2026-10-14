'use strict';

const { statusContext, overrideLabel, humanLabel, marker, overridePrefix, runUrl } = require('./constants.cjs');

async function setStatus(github, context, sha, state, description, name = statusContext, targetUrl = runUrl(context)) {
  await github.rest.repos.createCommitStatus({
    ...context.repo,
    sha,
    state,
    context: name,
    description,
    target_url: targetUrl,
  });
}

async function removeOverrideLabel(github, context) {
  try {
    await github.rest.issues.removeLabel({
      ...context.repo,
      issue_number: context.payload.pull_request.number,
      name: overrideLabel,
    });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function summaryComment(github, context, number) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: number,
    per_page: 100,
  });
  return comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(marker));
}

async function verdictStatus(github, context, sha) {
  const { data } = await github.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: sha, per_page: 100 });
  return data.statuses.find((s) => s.context === statusContext);
}

async function verdictState(github, context, sha) {
  return (await verdictStatus(github, context, sha))?.state ?? 'none';
}

async function permissionOf(github, context, username) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username });
    return data.permission;
  } catch (error) {
    if (error.status !== 404) throw error;
    return 'none';
  }
}

const canWrite = async (github, context, username) =>
  ['admin', 'write'].includes(await permissionOf(github, context, username));

async function livePull(github, context) {
  const { data } = await github.rest.pulls.get({ ...context.repo, pull_number: context.payload.pull_request.number });
  return data;
}

const isFork = (context, pull) => pull.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`;

// Reasons the head needs a person that come from the PR as it is now, not
// from its review.
async function liveReasons(github, context, pull, sha) {
  const reasons = [];
  if (isFork(context, pull)) reasons.push('The AI review does not run on fork PRs.');
  const status = await verdictStatus(github, context, sha);
  if (status?.state === 'success' && status.description?.startsWith(overridePrefix)) reasons.push(status.description);
  if (pull.labels?.some((l) => l.name === humanLabel)) reasons.push(`The ${humanLabel} label asks for one.`);
  return reasons;
}

module.exports = {
  setStatus,
  removeOverrideLabel,
  summaryComment,
  verdictStatus,
  verdictState,
  permissionOf,
  canWrite,
  livePull,
  isFork,
  liveReasons,
};
