'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSummary } = require('./github.cjs');
const { storedMarker } = require('./decision.cjs');

// Adds what earlier rounds of review said to a reviewer's inputs in `dir`, so
// it can see what an author answered, such as a finding deferred with a reason:
// - comments.jsonl: the PR's comments by people, and by the author when it is
//   a bot, oldest first, with when each was last edited, since an author's
//   latest answer counts. Other bots' comments, such as this review's summary
//   and migration or coverage reports, are not part of the conversation.
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
    .filter((c) => c.user?.type !== 'Bot' || c.user.login === author)
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
