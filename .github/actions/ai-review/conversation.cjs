'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSummary } = require('./github.cjs');

// The marker that ends the summary comment, for publish and the human gate.
const decisionMarker = /\n<!-- ai-review-human [A-Za-z0-9+/=]+ -->$/u;

// Adds what earlier rounds of review said to a reviewer's inputs in `dir`, so
// it can see what an author answered, such as a finding deferred with a reason:
// - comments.jsonl: the PR's comments by people, oldest first. Bots' comments,
//   such as this review's summary and migration or coverage reports, are not
//   part of the conversation.
// - previous-verdict.md: the summary comment as the last review left it, which
//   may be for an earlier head, or empty before the first.
async function conversation({ github, context }, dir) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: context.payload.pull_request.number,
    per_page: 100,
  });
  const people = comments
    .filter((c) => c.user?.type !== 'Bot')
    .map((c) => `${JSON.stringify({ author: c.user?.login ?? null, created_at: c.created_at, body: c.body ?? '' })}\n`);
  fs.writeFileSync(path.join(dir, 'comments.jsonl'), people.join(''));
  const summary = comments.find((c) => isSummary(c));
  fs.writeFileSync(
    path.join(dir, 'previous-verdict.md'),
    summary ? `${summary.body.replace(decisionMarker, '').trimEnd()}\n` : '',
  );
}

module.exports = { conversation };
