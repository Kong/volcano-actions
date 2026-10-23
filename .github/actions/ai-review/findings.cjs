'use strict';

const { severities, clean, joinNames } = require('./constants.cjs');
const { isLiveHead } = require('./github.cjs');
const { parsed, completed, cap, severityOf, shapeFinding } = require('./reviews.cjs');
const { grouped, deferred } = require('./problems.cjs');

// A finding's level and title, why it matters, and the models that found it.
// An older output, or a reviewer that omitted detail, still gets the rest.
function commentBody(f, signers) {
  const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
  return [
    `**${severities[severityOf(f)]}:** ${clean(cap(String(f.title), 200))}`,
    ...(detail ? [clean(cap(detail, 1500))] : []),
    `<sub>Found by ${joinNames(signers)}</sub>`,
  ].join('\n\n');
}

const onLine = (f) => Number.isInteger(f.line) && f.line > 0;
// The author already answered a deferred P2, and the summary lists it.
const answered = (f) => f.severity === 'p2' && f.deferred;

// One inline comment per problem on a line, with the problems grouped as the
// summary groups them (see problems.cjs): the comment of its most severe
// finding on a line, signed by every model that reported the problem, so a
// finding that stands alone keeps its own. A deferred problem gets none.
function inlineComments(reviewers) {
  const done = parsed(reviewers).filter((entry) => completed(entry.result, entry.review));
  const signer = (i) => clean(cap(done[i].model || done[i].name, 100));
  const groups = grouped(done.map(({ review }) => review.findings.map((f) => ({ ...shapeFinding(f), finding: f }))));
  return groups.flatMap((group) => {
    const lead = group.find((f) => onLine(f) && !answered(f));
    if (!lead || deferred(group)) return [];
    const signers = [...new Set(group.map((f) => signer(f.reviewer)))];
    return [{ path: String(lead.finding.path), line: lead.line, body: commentBody(lead.finding, signers), signers }];
  });
}

// A comment's level, as its first line gives it.
const levelOf = (body) => String(body).split('\n')[0].split(':**')[0];
const key = (path, line, body, signer) => JSON.stringify([path, line, levelOf(body), signer]);

// What one of this action's comments covers: its line and level for each model
// its footer names, and for the whole footer, so a model whose name holds
// "and" still matches itself.
function covered({ path, line, body }) {
  const footer = String(body)
    .split('\n')
    .at(-1)
    .replace(/^<sub>Found by (.*)<\/sub>$/u, '$1');
  return [footer, ...footer.split(/, and |, | and /u)].map((signer) => key(path, line, body, signer));
}

// What this action's comments already cover on the PR, or null when the PR's
// head or comments cannot be read; comments by anyone else never count. Only
// the live head's review comments, like the summary.
async function postedOn({ github, context, core }) {
  const pr = context.payload.pull_request;
  try {
    if (!(await isLiveHead(github, context))) {
      core.notice(`Skipped the inline comments on ${pr.head.sha.slice(0, 7)}, which is no longer the PR head.`);
      return null;
    }
    const existing = await github.paginate(github.rest.pulls.listReviewComments, {
      ...context.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    return new Set(existing.filter((c) => c.user?.login === 'github-actions[bot]').flatMap((c) => covered(c)));
  } catch (error) {
    core.warning(`Could not read the PR's head or review comments, so none were posted: ${error.message}`);
    return null;
  }
}

// Posts the inline comments on the reviewed head while it is the live head;
// like the summary, a newer head's review comments for itself. A model's
// wording varies between runs, so a later push skips a problem at a line where
// this action already posted a finding at the same level from any model that
// reported it. Comments sit beside the verdict, so no failure here fails the
// job.
async function postFindings({ github, context, core }, reviewers) {
  const pr = context.payload.pull_request;
  const comments = [...new Map(inlineComments(reviewers).map((c) => [JSON.stringify(c), c])).values()];
  if (comments.length === 0) return;
  const posted = await postedOn({ github, context, core });
  if (!posted) return;
  for (const { path, line, body, signers } of comments) {
    if (signers.some((signer) => posted.has(key(path, line, body, signer)))) continue;
    try {
      await github.rest.pulls.createReviewComment({
        ...context.repo,
        pull_number: pr.number,
        commit_id: pr.head.sha,
        side: 'RIGHT',
        path,
        line,
        body,
      });
    } catch (error) {
      const where = `${path}:${line}`;
      if (error.status === 422) core.notice(`Skipped the comment on ${where}, which is outside the diff.`);
      else core.warning(`Could not comment on ${where}: ${error.message}`);
    }
  }
}

module.exports = { postFindings };
