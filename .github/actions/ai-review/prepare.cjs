'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { candidates } = require('./candidates.cjs');
const { conversation } = require('./conversation.cjs');
const { selfApproverOf } = require('./self-approval.cjs');

// What a self-approver may merge on the review's decision (see
// self-approval.cjs), as the policy puts it, or nothing for anyone else.
function selfApproval(author) {
  const scopes = (selfApproverOf(author)?.scopes ?? []).map((s) => s.replace(/\.$/u, ''));
  if (scopes.length === 0) return '';
  return [
    ...(scopes.length === 1
      ? [`The PR author may merge without a person only a change that is ${scopes[0]}.`]
      : ['The PR author may merge without a person only a change that is one of:', ...scopes.map((s) => `- ${s}`)]),
    'Anything else needs a person, even a simple, low-risk change the cases',
    'above would clear; give as the reason what the change does beyond that.',
  ].join('\n');
}

// The review policy every reviewer gets, with this PR's values filled in. The
// caller's focus bullets extend the shared list, and a self-approver's scope
// narrows when a person is needed; each line drops out when empty. One pass,
// so a value cannot introduce another placeholder.
const optional = new Set(['focus', 'self_approval']);

function policy(context, inputs, focus = '') {
  const pr = context.payload.pull_request;
  const values = {
    repo: `${context.repo.owner}/${context.repo.repo}`,
    number: String(pr.number),
    author: pr.user.login,
    base: pr.base.sha,
    head: pr.head.sha,
    inputs,
    focus: focus.trim() ? focus.trimEnd() : '',
    self_approval: selfApproval(pr.user),
  };
  const text = fs.readFileSync(path.join(__dirname, 'policy.md'), 'utf8');
  return text.replaceAll(/\{\{(\w+)\}\}(\n?)/gu, (_, name, newline) => {
    if (!Object.hasOwn(values, name)) throw new Error(`policy.md has an unknown placeholder: {{${name}}}`);
    return optional.has(name) && !values[name] ? '' : `${values[name]}${newline}`;
  });
}

const withoutMaxLength = (node) => {
  if (Array.isArray(node)) return node.map((v) => withoutMaxLength(v));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'maxLength')
      .map(([key, v]) => [key, withoutMaxLength(v)]),
  );
};

// The review output schema on one line, as a CLI argument takes it, and a copy
// without maxLength for providers whose structured outputs reject it, such as
// OpenAI's. publish caps the lengths either way.
function schemas() {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
  return { schema: JSON.stringify(schema), withoutMaxLength: JSON.stringify(withoutMaxLength(schema)) };
}

// Adds reviewers.jsonl, comments.jsonl, and previous-verdict.md to the inputs
// prepare.sh wrote and sets what a reviewer job reads. setOutput writes each value under a random delimiter, so a
// multi-line one cannot end its output early.
async function prepare({ github, context, core }) {
  // action.yml gives prepare.sh and this step the same directory.
  const dir = process.env.INPUTS;
  const logins = await candidates({ github, context, core }, dir);
  await conversation({ github, context }, dir);
  const { schema, withoutMaxLength: bare } = schemas();
  core.setOutput('inputs', dir);
  core.setOutput('candidates', JSON.stringify(logins));
  core.setOutput('policy', policy(context, dir, process.env.FOCUS || ''));
  core.setOutput('schema', schema);
  core.setOutput('schema-without-max-length', bare);
}

module.exports = { policy, schemas, prepare };
