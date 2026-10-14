'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { statusContext, overrideLabel, humanLabel } = require('./claude-review.cjs');
const { root, readRepo, action, sha, url, client, context, core } = require('./test-helpers.cjs');
const { tempDir } = require('./test-git.cjs');

const reviewWorkflow = () => readRepo('.github/workflows/claude-review.yml');
const jobsOf = (workflow) =>
  Object.fromEntries(
    workflow
      .split('\njobs:\n')[1]
      .split(/\n(?=  [a-z-]+:\n)/u)
      .map((job) => [job.match(/^ {2}([a-z-]+):/u)[1], job]),
  );

test('the workflow keeps the reviewer inside its trust boundary', () => {
  const workflow = reviewWorkflow();
  execFileSync('git', ['merge-base', '--is-ancestor', action.split('@')[1], 'origin/main'], { cwd: root });
  const jobs = jobsOf(workflow);
  assert.deepEqual(Object.keys(jobs), ['start', 'review', 'verdict', 'override']);

  // Callers choose the trigger; every job that acts runs only under
  // pull_request_target, which mints for the caller's protected base.
  assert.match(workflow, /\non:\n {2}workflow_call:\n/u);
  assert.doesNotMatch(
    workflow,
    /\n {2}(pull_request|pull_request_target|issue_comment|workflow_dispatch|push|merge_group):/u,
  );
  for (const name of ['start', 'override'])
    assert.match(jobs[name], /github\.event_name == 'pull_request_target'/u, name);
  assert.match(workflow, /\npermissions: \{\}\n/u);

  // Forks never reach the job that holds the federation token.
  assert.match(jobs.start, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  // The payload's draft flag can be stale; start() checks the live PR.
  assert.doesNotMatch(workflow, /pull_request\.draft/u);
  assert.match(jobs.review, /needs: start\n {4}if: needs\.start\.outputs\.review == 'true'\n/u);
  assert.match(jobs.review, /CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'/u);
  assert.match(jobs.review, /allowed_bots: \$\{\{ inputs\.allowed_bots \}\}\n/u);
  assert.match(workflow, /\n {6}allowed_bots:\n(?: {8}.*\n)*? {8}default: dependabot\[bot\],kong\[bot\]\n/u);
  assert.match(jobs.review, /id-token: write/u);
  for (const name of ['start', 'verdict', 'override']) assert.doesNotMatch(jobs[name], /id-token/u, name);
});

test("a caller's API key replaces the federation rather than joining it", () => {
  const workflow = reviewWorkflow();
  const { review } = jobsOf(workflow);
  assert.match(review, /\n {10}anthropic_api_key: \$\{\{ secrets\.anthropic_api_key \}\}\n/u);
  const federation = review.match(
    /\n {10}anthropic_(?:federation_rule|organization|service_account|workspace)_id: .*/gu,
  );
  assert.equal(federation.length, 4);
  for (const line of federation) assert.match(line, /: \$\{\{ !secrets\.anthropic_api_key && '[\w-]+' \|\| '' \}\}$/u);
  assert.match(workflow, /\n {4}secrets:\n {6}anthropic_api_key:\n(?: {8}.*\n)*? {8}required: false\n/u);
});

test('only events for one head share a review run group', () => {
  const workflow = reviewWorkflow();
  // Only events for one head share a run group, so a stale run cannot cancel
  // the live head's review; labels, edits, and reopens never cancel a review.
  const [, group, cancel] = workflow.match(
    /\nconcurrency:\n {2}group: claude-review-\$\{\{ (.*) \}\}\n {2}cancel-in-progress: \$\{\{ (.*) \}\}\n/u,
  );
  assert.equal(
    group,
    `(contains(fromJSON('["opened","synchronize","ready_for_review"]'), github.event.action) || (github.event.action == 'edited' && github.event.changes.base)) && format('{0}-{1}', github.event.pull_request.number, github.event.pull_request.head.sha) || github.run_id`,
  );
  assert.equal(cancel, 'github.run_attempt == 1');
  assert.doesNotMatch(group, /reopened|labeled/u);
  assert.doesNotMatch(workflow.split('\njobs:\n')[1], /concurrency:/u);
});

test('Claude reads the head with no shell, and jobs with a write token never check out the PR', () => {
  const jobs = jobsOf(reviewWorkflow());
  // Claude runs in a base checkout and reads the head from a separate worktree,
  // with no shell. The jobs holding a write token load the script from this
  // repository's pinned revision and never check out the PR.
  assert.deepEqual(jobs.review.match(/ ref: .*/gu), [' ref: ${{ github.event.pull_request.base.sha }}']);
  assert.match(jobs.review, /\n {10}git worktree add --quiet --detach "\$INPUTS\/head" "\$HEAD_SHA"\n/u);
  for (const [name, step] of [
    ['start', 'start'],
    ['verdict', 'publish'],
    ['override', 'override'],
  ]) {
    assert.doesNotMatch(jobs[name], /actions\/checkout|github-script/u, name);
    assert.deepEqual(jobs[name].match(/(?<![\w-])uses: .*/gu), [`uses: ${action}`], name);
    assert.match(jobs[name], new RegExp(`\\n {10}step: ${step}\\n`, 'u'), name);
  }
  assert.match(jobs.review, /--allowedTools "Read,Grep,Glob,mcp__github_inline_comment__create_inline_comment"\n/u);
  assert.match(jobs.review, /--disallowedTools "Bash,/u);
  // Only the action's own MCP servers start; a caller's .mcp.json does not.
  assert.match(jobs.review, /\n {12}--strict-mcp-config\n/u);
  assert.match(jobs.review, /"blockReadsOutsideWorkingDirectories":true/u);
  assert.match(jobs.review, /"Read\(\/\$\{\{ github\.workspace \}\}\/\.git\/\*\*\)"/u);
});

test('the review workflow interpolates no untrusted event text', () => {
  const workflow = reviewWorkflow();
  const jobs = jobsOf(workflow);
  // Untrusted event text never reaches a shell or the prompt by interpolation.
  // Inputs come from the caller's base-branch stub.
  assert.doesNotMatch(workflow, /github\.event\.(pull_request\.(title|body)|comment|review|head_commit)/u);
  assert.match(jobs.review, /\n {12}- Code quality and best practices\n {12}\$\{\{ inputs\.focus \}\}\n/u);
  assert.match(jobs.override, new RegExp(`github\\.event\\.label\\.name == '${overrideLabel}'`, 'u'));
  assert.match(jobs.verdict, /\n {10}human-review-paths: \$\{\{ inputs\.human_review_paths \}\}\n/u);
});

test('reviewer candidates come from the base history before Claude runs', () => {
  const jobs = jobsOf(reviewWorkflow());
  // Reviewer candidates come from the base's history, found by this
  // repository's action before Claude runs, and reach publish as a job output.
  const steps = jobs.review.split('\n    steps:\n')[1];
  assert.ok(steps.indexOf('- name: Prepare review inputs') < steps.indexOf('- id: candidates'));
  assert.ok(steps.indexOf('- id: candidates') < steps.indexOf('- id: claude'));
  assert.ok(steps.includes(`- id: candidates\n        uses: ${action}\n        with:\n          step: candidates\n`));
  assert.match(jobs.review, /\n {6}candidates: \$\{\{ steps\.candidates\.outputs\.candidates \}\}\n/u);
  assert.match(jobs.verdict, /\n {10}reviewer-candidates: \$\{\{ needs\.review\.outputs\.candidates \}\}\n/u);
});

test('the reusable review and composite action pin every action to a full commit SHA', () => {
  for (const file of [
    '.github/workflows/claude-review.yml',
    '.github/workflows/claude-review-human.yml',
    '.github/actions/claude-review/action.yml',
  ]) {
    const refs = [...readRepo(file).matchAll(/\buses: ([^\s#]+)/gu)].map((match) => match[1]);
    assert.ok(refs.length > 0, file);
    for (const ref of refs) assert.match(ref, /^[^@]+@[a-f0-9]{40}$/u, `${file}: ${ref}`);
  }
});

// Check the deployed pair; action changes can land before their pin and schema
// update. The current action's behavior has its own verdict unit tests.
test('the pinned verdict matches the review schema and documented override policy', async (t) => {
  const workflow = reviewWorkflow();
  const schema = JSON.parse(workflow.match(/\n {12}--json-schema '(.*)'\n/u)[1]);
  const pinnedSha = action.split('@')[1];
  const dir = tempDir(t, 'claude-review-pinned-');
  const archive = path.join(dir, 'pinned.tar');
  execFileSync('git', ['archive', '--output', archive, pinnedSha], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  const pinned = require(path.join(dir, '.github/actions/claude-review/claude-review.cjs'));
  const levels = schema.properties.findings.items.properties.severity.enum;
  assert.deepEqual(Object.keys(pinned.severities), levels, 'pinned');

  const c = client({ statuses: [{ context: statusContext, state: 'failure' }] });
  const k = core();
  await pinned.override({ github: c.github, context: context({ sender: { login: 'author', type: 'User' } }), core: k });
  const authorsAllowed = k.failures.length === 0;
  const readme = readRepo('README.md');
  assert.ok(readme.includes(authorsAllowed ? 'including the PR author' : 'other than the PR author'));
  const description = readme.match(/Create the `claude-review-override` label with the description:\s*"([^"]+)"/u)[1];
  assert.ok(description.includes(authorsAllowed ? 'PR author included' : 'non-author'));

  // The pinned action reads the human review decision the schema asks for.
  const human = schema.properties.human_review;
  assert.ok(schema.required.includes('human_review'));
  assert.deepEqual(human.required, ['needed', 'reasons', 'reviewer', 'reviewer_reason']);
  assert.equal(human.properties.needed.type, 'boolean');
  assert.equal(typeof pinned.gate, 'function');
  assert.equal(typeof pinned.candidates, 'function');
  const decide = (needed) =>
    pinned.verdict(
      'success',
      JSON.stringify({
        summary: 's',
        findings: [],
        human_review: { needed, reasons: ['Changes billing.'], reviewer: 'bob', reviewer_reason: 'wrote billing' },
      }),
      sha,
      url,
      ['alice', 'bob'],
    );
  assert.deepEqual(decide(false).reasons, []);
  assert.deepEqual(decide(true).reasons, ['Changes billing.']);
  assert.deepEqual(decide(true).reviewer, { login: 'bob', why: 'wrote billing' });
  // The schema rides in single quotes in claude_args.
  assert.doesNotMatch(workflow.match(/\n {12}--json-schema '(.*)'\n/u)[1], /'/u);
});

// Reviews run the PR's own copy of their workflow, so the gate runs only from
// workflow_run or a label's pull_request_target, both read from the base.
test('the human gate runs from the base branch without a checkout or OIDC token', () => {
  const workflow = readRepo('.github/workflows/claude-review-human.yml');
  assert.match(workflow, /\non:\n {2}workflow_call:\n\npermissions: \{\}\n/u);
  assert.match(
    workflow,
    /\nconcurrency:\n {2}group: claude-review-human-\$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.event\.pull_request\.head\.sha \}\}\n {2}cancel-in-progress: false\n/u,
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

test('the prompt treats a binary summary of a non-binary path as hidden content', () => {
  const workflow = reviewWorkflow();
  assert.match(
    workflow,
    /`Binary files \.\.\. differ` line with no text diff of the same file\n {12}later in pr\.diff hides that file's content/u,
  );
  assert.match(workflow, /report the hidden content as a P1 finding/u);
});

test('a hung review fails the job instead of leaving the head pending', () => {
  const workflow = reviewWorkflow();
  const job = Number(workflow.split('\n  review:\n')[1].match(/\n {4}timeout-minutes: (\d+)\n/u)[1]);
  const step = Number(workflow.split('- id: claude\n')[1].match(/^ {8}(?:#.*\n {8})*timeout-minutes: (\d+)\n/u)[1]);
  assert.ok(step < job, `step ${step} must time out before job ${job}`);
});

test('the action runs only the exported steps and passes inputs through env', () => {
  const yml = readRepo('.github/actions/claude-review/action.yml');
  assert.match(yml, /\n {2}using: composite\n/u);
  assert.match(yml, /CLAUDE_REVIEW_SCRIPT: \$\{\{ github\.action_path \}\}\/claude-review\.cjs\n/u);
  const script = yml.split('script: |\n')[1];
  assert.doesNotMatch(script, /\$\{\{/u);
  for (const step of JSON.parse(script.match(/\[('start'.*?)\]/u)[0].replaceAll("'", '"'))) {
    assert.equal(typeof require('./claude-review.cjs')[step], 'function', step);
  }
});
