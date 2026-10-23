'use strict';

const { severities, clean } = require('./constants.cjs');
const { isLiveHead } = require('./github.cjs');
const { parsed, completed, cap, severityOf } = require('./reviews.cjs');

// A finding's level and title, why it matters, and the model that found it.
// An older output, or a reviewer that omitted detail, still gets the rest.
function commentBody(f, signer) {
  const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
  return [
    `**${severities[severityOf(f)]}:** ${clean(cap(String(f.title), 200))}`,
    ...(detail ? [clean(cap(detail, 1500))] : []),
    `<sub>Found by ${clean(cap(signer, 100))}</sub>`,
  ].join('\n\n');
}

// Each completed review's findings on a line, as inline comments signed by
// the model that found them.
const inlineComments = (reviewers) =>
  parsed(reviewers)
    .filter((entry) => completed(entry.result, entry.review))
    .flatMap(({ name, model, review }) =>
      review.findings
        // The author already answered a deferred P2, and the summary lists it.
        .filter((f) => Number.isInteger(f.line) && f.line > 0 && !(severityOf(f) === 'p2' && f.deferred === true))
        .map((f) => ({ path: String(f.path), line: f.line, body: commentBody(f, model || name) })),
    );

// Posts the inline comments on the reviewed head while it is the live head;
// like the summary, a newer head's review comments for itself. Reviewers may
// comment on the same problem. A model's wording varies between runs, so a
// later push skips a line where this action already posted the same model's
// finding at the same level; comments by anyone else never count. Comments sit
// beside the verdict, so no failure here fails the job.
async function postFindings({ github, context, core }, reviewers) {
  const pr = context.payload.pull_request;
  const comments = [...new Map(inlineComments(reviewers).map((c) => [JSON.stringify(c), c])).values()];
  if (comments.length === 0) return;
  const lines = (body) => String(body).split('\n');
  const at = (c) => JSON.stringify([c.path, c.line, lines(c.body)[0].split(':**')[0], lines(c.body).at(-1)]);
  let posted;
  try {
    if (!(await isLiveHead(github, context))) {
      core.notice(`Skipped the inline comments on ${pr.head.sha.slice(0, 7)}, which is no longer the PR head.`);
      return;
    }
    const existing = await github.paginate(github.rest.pulls.listReviewComments, {
      ...context.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    posted = new Set(existing.filter((c) => c.user?.login === 'github-actions[bot]').map((c) => at(c)));
  } catch (error) {
    core.warning(`Could not read the PR's head or review comments, so none were posted: ${error.message}`);
    return;
  }
  for (const comment of comments) {
    if (posted.has(at(comment))) continue;
    try {
      await github.rest.pulls.createReviewComment({
        ...context.repo,
        pull_number: pr.number,
        commit_id: pr.head.sha,
        side: 'RIGHT',
        ...comment,
      });
    } catch (error) {
      const where = `${comment.path}:${comment.line}`;
      if (error.status === 422) core.notice(`Skipped the comment on ${where}, which is outside the diff.`);
      else core.warning(`Could not comment on ${where}: ${error.message}`);
    }
  }
}

module.exports = { postFindings };
