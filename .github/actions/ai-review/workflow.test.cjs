'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { statusContext, overrideLabel, humanLabel } = require('./ai-review.cjs');
const { root, readRepo, sha, url, client, context, core } = require('./test-helpers.cjs');
const { tempDir } = require('./test-git.cjs');
const { reviewWorkflow, action, jobsOf, reviewerJobs } = require('./test-workflow.cjs');

const humanWorkflow = () => readRepo('.github/workflows/ai-review-human.yml');

// CI fetches main's history, so a commit squash-merging dropped fails here.
test('the review workflows pin one action commit that is on main', () => {
  for (const workflow of [reviewWorkflow(), humanWorkflow()]) {
    const refs = [...workflow.matchAll(/uses: (Kong\/volcano-actions\/\.github\/actions\/[^\s#]+)/gu)].map((m) => m[1]);
    assert.ok(refs.length > 0);
    for (const ref of refs) assert.equal(ref, action);
  }
  execFileSync('git', ['merge-base', '--is-ancestor', action.split('@')[1], 'origin/main'], { cwd: root });
});

test('the workflow keeps every reviewer inside its trust boundary', () => {
  const workflow = reviewWorkflow();
  const jobs = jobsOf(workflow);
  assert.deepEqual(Object.keys(jobs), ['start', 'claude', 'codex', 'verdict', 'override']);

  // Callers choose the trigger; every job that acts runs only under
  // pull_request_target, which runs the caller's base-branch stub.
  assert.match(workflow, /\non:\n {2}workflow_call:\n/u);
  assert.doesNotMatch(
    workflow,
    /\n {2}(pull_request|pull_request_target|issue_comment|workflow_dispatch|push|merge_group):/u,
  );
  for (const name of ['start', 'override'])
    assert.match(jobs[name], /github\.event_name == 'pull_request_target'/u, name);
  assert.match(workflow, /\npermissions: \{\}\n/u);

  // Forks never reach the jobs that hold the API keys.
  assert.match(jobs.start, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  for (const name of reviewerJobs(jobs)) {
    assert.match(jobs[name], /\n {4}needs: start\n {4}if: needs\.start\.outputs\.review == 'true'\n/u, name);
  }
  // The payload's draft flag can be stale; start() checks the live PR.
  assert.doesNotMatch(workflow, /pull_request\.draft/u);
  assert.match(jobs.claude, /CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'/u);
  assert.match(jobs.claude, /\n {10}allowed_bots: \$\{\{ inputs\.allowed_bots \}\}\n/u);
  assert.match(jobs.codex, /\n {10}allow-bot-users: \$\{\{ inputs\.allowed_bots \}\}\n/u);
  assert.match(
    workflow,
    /\n {6}allowed_bots:\n(?: {8}.*\n)*? {8}default: dependabot\[bot\],kong\[bot\],kong-volcano-app\[bot\]\n/u,
  );
  assert.doesNotMatch(workflow, /id-token/u);
});

test('every reviewer key is an optional secret the caller passes', () => {
  const workflow = reviewWorkflow();
  for (const secret of ['anthropic_api_key', 'openai_api_key']) {
    assert.match(workflow, new RegExp(`\\n {6}${secret}:\\n(?: {8}.*\\n)*? {8}required: false\\n`, 'u'), secret);
  }
  assert.doesNotMatch(workflow, /anthropic_(?:federation_rule|organization|service_account|workspace)_id/u);
});

test('only events for one head share a review run group', () => {
  const workflow = reviewWorkflow();
  // Only events for one head share a run group, so a stale run cannot cancel
  // the live head's review; labels, edits, and reopens never cancel a review.
  const [, group, cancel] = workflow.match(
    /\nconcurrency:\n {2}group: ai-review-\$\{\{ (.*) \}\}\n {2}cancel-in-progress: \$\{\{ (.*) \}\}\n/u,
  );
  assert.equal(
    group,
    `(contains(fromJSON('["opened","synchronize","ready_for_review"]'), github.event.action) || (github.event.action == 'edited' && github.event.changes.base)) && format('{0}-{1}', github.event.pull_request.number, github.event.pull_request.head.sha) || github.run_id`,
  );
  assert.equal(cancel, 'github.run_attempt == 1');
  assert.doesNotMatch(group, /reopened|labeled/u);
  assert.doesNotMatch(workflow.split('\njobs:\n')[1], /concurrency:/u);
});

test('jobs with a write token never check out the PR, and Claude reads it with no shell', () => {
  const jobs = jobsOf(reviewWorkflow());
  // The jobs holding a write token load the script from this repository's
  // pinned revision and never check out the PR.
  for (const [name, step] of [
    ['start', 'start'],
    ['verdict', 'publish'],
    ['override', 'override'],
  ]) {
    assert.doesNotMatch(jobs[name], /actions\/checkout|github-script/u, name);
    assert.deepEqual(jobs[name].match(/(?<![\w-])uses: .*/gu), [`uses: ${action}`], name);
    assert.match(jobs[name], new RegExp(`\\n {10}step: ${step}\\n`, 'u'), name);
  }
  assert.match(jobs.claude, /--allowedTools "Read,Grep,Glob,mcp__github_inline_comment__create_inline_comment"\n/u);
  assert.match(jobs.claude, /--disallowedTools "Bash,/u);
  // Only the action's own MCP servers start; a caller's .mcp.json does not.
  assert.match(jobs.claude, /\n {12}--strict-mcp-config\n/u);
  assert.match(jobs.claude, /"blockReadsOutsideWorkingDirectories":true/u);
  assert.match(jobs.claude, /"Read\(\/\$\{\{ github\.workspace \}\}\/\.git\/\*\*\)"/u);
});

test('the review workflow interpolates no untrusted event text', () => {
  const workflow = reviewWorkflow();
  const jobs = jobsOf(workflow);
  // Untrusted event text never reaches a shell or a prompt by interpolation.
  // Inputs come from the caller's base-branch stub.
  assert.doesNotMatch(workflow, /github\.event\.(pull_request\.(title|body)|comment|review|head_commit)/u);
  assert.match(jobs.override, new RegExp(`github\\.event\\.label\\.name == '${overrideLabel}'`, 'u'));
  assert.match(jobs.verdict, /\n {10}human-review-paths: \$\{\{ inputs\.human_review_paths \}\}\n/u);
});

test('the reusable workflows and composite action pin every action to a full commit SHA', () => {
  for (const file of [
    '.github/workflows/ai-review.yml',
    '.github/workflows/ai-review-human.yml',
    '.github/actions/ai-review/action.yml',
  ]) {
    const refs = [...readRepo(file).matchAll(/\buses: ([^\s#]+)/gu)].map((match) => match[1]);
    assert.ok(refs.length > 0, file);
    for (const ref of refs) assert.match(ref, /^[^@]+@[a-f0-9]{40}$/u, `${file}: ${ref}`);
  }
});

// Loads the action at the workflows' pin, which can trail this checkout's.
function pinnedAction(t) {
  const dir = tempDir(t, 'ai-review-pinned-');
  const archive = path.join(dir, 'pinned.tar');
  execFileSync('git', ['archive', '--output', archive, action.split('@')[1]], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  const at = path.join(dir, '.github/actions/ai-review');
  return {
    pinned: require(path.join(at, 'ai-review.cjs')),
    schema: JSON.parse(fs.readFileSync(path.join(at, 'schema.json'))),
  };
}

// Check the deployed action; changes here can land before the pin moves. The
// current action's behavior has its own unit tests.
test('the pinned action matches its schema and the documented override policy', async (t) => {
  const { pinned, schema } = pinnedAction(t);
  assert.deepEqual(Object.keys(pinned.severities), schema.properties.findings.items.properties.severity.enum);

  const c = client({ statuses: [{ context: statusContext, state: 'failure' }] });
  const k = core();
  await pinned.override({ github: c.github, context: context({ sender: { login: 'author', type: 'User' } }), core: k });
  const authorsAllowed = k.failures.length === 0;
  const readme = readRepo('README.md');
  assert.ok(readme.includes(authorsAllowed ? 'including the PR author' : 'other than the PR author'));
  const description = readme.match(/Create the `ai-review-override` label with the description:\s*"([^"]+)"/u)[1];
  assert.ok(description.includes(authorsAllowed ? 'PR author included' : 'non-author'));

  // The pinned action reads the human review decision its schema asks for.
  assert.deepEqual(schema.properties.human_review.required, ['needed', 'reasons', 'reviewer', 'reviewer_reason']);
  for (const step of ['prepare', 'start', 'publish', 'override', 'gate']) assert.equal(typeof pinned[step], 'function');
  const decide = (needed) =>
    pinned.verdict(
      [
        {
          name: 'Claude',
          result: 'success',
          output: JSON.stringify({
            summary: 's',
            findings: [],
            human_review: { needed, reasons: ['Changes billing.'], reviewer: 'bob', reviewer_reason: 'wrote billing' },
          }),
        },
      ],
      sha,
      url,
      ['alice', 'bob'],
    );
  assert.deepEqual(decide(false).reasons, []);
  assert.deepEqual(decide(true).reasons, ['Changes billing.']);
  assert.deepEqual(decide(true).reviewer, { login: 'bob', why: 'wrote billing' });
});

// Reviews run the PR's own copy of their workflow, so the gate runs only from
// workflow_run or a label's pull_request_target, both read from the base.
test('the human gate runs from the base branch without a checkout or OIDC token', () => {
  const workflow = humanWorkflow();
  assert.match(workflow, /\non:\n {2}workflow_call:\n\npermissions: \{\}\n/u);
  assert.match(
    workflow,
    /\nconcurrency:\n {2}group: ai-review-human-\$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.event\.pull_request\.head\.sha \}\}\n {2}cancel-in-progress: false\n/u,
  );
  const jobs = workflow.split('\njobs:\n')[1];
  assert.deepEqual(jobs.match(/^ {2}[a-z-]+:/gmu), ['  gate:']);
  assert.ok(
    jobs.includes(
      `(github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request_review') ||\n      (github.event_name == 'pull_request_target' && github.event.label.name == '${humanLabel}')\n`,
    ),
  );
  assert.match(
    jobs,
    /\n {4}permissions:\n {6}contents: read\n {6}pull-requests: write\n {6}statuses: write\n {4}steps:\n/u,
  );
  assert.doesNotMatch(workflow, /actions\/checkout|github-script|id-token|secrets/u);
  assert.deepEqual(jobs.match(/(?<![\w-])uses: .*/gu), [`uses: ${action}`]);
  assert.match(jobs, /\n {10}step: gate\n/u);
});
