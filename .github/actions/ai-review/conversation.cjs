'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSummary } = require('./github.cjs');
const { storedMarker } = require('./decision.cjs');

const insiders = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Adds what earlier rounds of review said to a reviewer's inputs in `dir`, so
// it can see what an author answered, such as a finding deferred with a reason:
// - comments.jsonl: the PR's comments by its author and by the repository's
//   owners, members, and collaborators, oldest first, with when each was last
//   edited, since an author's latest answer counts. Bots' comments other than
//   the author's, such as this review's summary and migration or coverage
//   reports, and comments by anyone outside the repository stay out.
// - previous-verdict.md: the summary comment as the last review left it, which
//   may be for an earlier head, or empty before the first.
async function conversation({ github, context }, dir) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: context.payload.pull_request.number,
    per_page: 100,
  });
  const author = context.payload.pull_request.user.login;
  const people = comments
    .filter((c) => c.user?.login === author || (c.user?.type !== 'Bot' && insiders.has(c.author_association)))
    .map((c) => ({
      author: c.user?.login ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at,
      body: c.body ?? '',
    }))
    .map((c) => `${JSON.stringify(c)}\n`);
  fs.writeFileSync(path.join(dir, 'comments.jsonl'), people.join(''));
  const summary = comments.find((c) => isSummary(c));
  fs.writeFileSync(
    path.join(dir, 'previous-verdict.md'),
    summary ? `${summary.body.replace(storedMarker, '').trimEnd()}\n` : '',
  );
}

module.exports = { conversation };
