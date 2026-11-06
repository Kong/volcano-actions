'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { candidates } = require('./candidates.cjs');
const { conversation } = require('./conversation.cjs');
const { selfApproverOf, flagMark } = require('./self-approval.cjs');

// What a self-approver may merge on the review's decision (see
// self-approval.cjs), as the policy puts it, or nothing for anyone else. A
// scope behind a feature flag numbers the list, for the review to say which
// one it clears and cite the flag checks.
function selfApproval(author) {
  const own = selfApproverOf(author);
  const bare = (s) => s.replace(/\.$/u, '');
  const scopes = (own?.scopes ?? []).map((s) => bare(s));
  if (scopes.length === 0) return '';
  const anythingElse = [
    'Anything else needs a person, even a simple, low-risk change the cases',
    'above would clear; give as the reason what the change does beyond that.',
  ];
  if (own.flagged.length > 0) {
    return [
      'The PR author may merge without a person only a change that is one of:',
      ...own.scopes.map((s, i) => `${i + 1}. ${bare(s)}${own.flagged.includes(s) ? ` ${flagMark}` : ''}`),
      ...anythingElse,
      'Set human_review.within to the number of the case the change is, or 0',
      'when it needs a person. For a case behind a feature flag, list in',
      'human_review.flag_gates each flag check that keeps the changed code from',
      'running or rendering while its flag is off: its file, its line in the',
      "head revision, and the flag's name as the code spells it. Cite only checks",
      'the base revision already has. A change that adds or changes the check it',
      'relies on, or code that also runs while the flag is off, needs a person.',
      'Otherwise leave flag_gates empty.',
    ].join('\n');
  }
  return [
    ...(scopes.length === 1
      ? [`The PR author may merge without a person only a change that is ${scopes[0]}.`]
      : ['The PR author may merge without a person only a change that is one of:', ...scopes.map((s) => `- ${s}`)]),
    ...anythingElse,
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

// What a review clearing a change behind a feature flag reports, so publish
// can verify it (see flag-gates.cjs).
const flagFields = {
  within: {
    type: 'integer',
    minimum: 0,
    description: 'The number of the case the PR author may merge without a person that the change is, or 0.',
  },
  flag_gates: {
    type: 'array',
    maxItems: 20,
    description: 'For a case behind a feature flag, each flag check that keeps the changed code off; otherwise empty.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'line', 'flag'],
      properties: {
        path: { type: 'string', maxLength: 300, description: 'Repository-relative path of the check.' },
        line: { type: 'integer', minimum: 1, description: 'The line of the check in the head revision.' },
        flag: { type: 'string', maxLength: 100, description: 'The name of the flag as the code spells it.' },
      },
    },
  },
};

// The review output schema on one line, as a CLI argument takes it, and a copy
// without maxLength for providers whose structured outputs reject it, such as
// OpenAI's. publish caps the lengths either way. A self-approver with a scope
// behind a feature flag, `author`, also reports the flag checks.
function schemas(author = null) {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
  if (selfApproverOf(author)?.flagged.length > 0) {
    const human = schema.properties.human_review;
    Object.assign(human.properties, flagFields);
    human.required.push(...Object.keys(flagFields));
  }
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
  const { schema, withoutMaxLength: bare } = schemas(context.payload.pull_request.user);
  core.setOutput('inputs', dir);
  core.setOutput('candidates', JSON.stringify(logins));
  core.setOutput('policy', policy(context, dir, process.env.FOCUS || ''));
  core.setOutput('schema', schema);
  core.setOutput('schema-without-max-length', bare);
}

module.exports = { policy, schemas, prepare };
