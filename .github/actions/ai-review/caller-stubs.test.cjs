'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { overrideLabel, humanLabel } = require('./ai-review.cjs');
const { readRepo } = require('./test-helpers.cjs');

test('the documented label descriptions fit GitHub limits', () => {
  for (const label of [overrideLabel, humanLabel]) {
    const description = readRepo('README.md').match(
      new RegExp(`Create the \`${label}\` label with the description:\\s*"([^"]+)"`, 'u'),
    )[1];
    assert.ok(description.length > 0 && description.length <= 100, description);
  }
});

// The stubs other repositories copy: the right triggers, every permission the
// called jobs use, and no concurrency group that could deadlock with its own.
// Edits and labels run in a second workflow with other check names, so their
// skipped runs cannot hide the review's checks on the PR page.
test('the caller stubs grant what the review needs and set no concurrency', () => {
  const stubs = {
    'pr-ai-review.yml': {
      name: 'AI Review',
      job: 'ai-review',
      types: 'opened, synchronize, reopened, ready_for_review',
    },
    'pr-ai-review-retarget-override.yml': {
      name: 'AI Review (retarget and override)',
      job: 'retarget-or-override',
      types: 'edited, labeled',
      if: `github.event.changes.base || github.event.label.name == '${overrideLabel}'`,
    },
  };
  // README.md shows them inside a list item, indented three spaces.
  const readme = readRepo('README.md').replaceAll(/^ {3}/gmu, '');
  for (const [file, want] of Object.entries(stubs)) {
    const stub = readRepo(`.github/workflows/${file}`);
    const shown = stub.slice(stub.indexOf('\nname: ') + 1);
    assert.match(shown, new RegExp(`^name: ${want.name.replaceAll(/[()]/gu, '\\$&')}\n`, 'u'), file);
    assert.match(
      stub,
      new RegExp(`\n {2}pull_request_target:\n {4}branches: \\[main\\]\n {4}types: \\[${want.types}\\]\n`, 'u'),
      file,
    );
    assert.match(stub, /\npermissions: \{\}\n/u, file);
    const ifLine = want.if ? ` {4}if: ${want.if.replaceAll(/[.|()]/gu, '\\$&')}\n` : '';
    assert.match(
      stub,
      new RegExp(
        `\njobs:\n {2}${want.job}:\n${ifLine} {4}uses: Kong/volcano-actions/\\.github/workflows/ai-review\\.yml@main\n`,
        'u',
      ),
      file,
    );
    assert.match(
      stub,
      /\n {4}permissions:\n {6}actions: write\n {6}contents: read\n {6}pull-requests: write\n {6}statuses: write\n {4}secrets:\n {6}anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_CI_API_KEY \}\}\n {6}codex_access_token: \$\{\{ secrets\.CODEX_CI_ACCESS_TOKEN \}\}\n$/u,
      file,
    );
    assert.doesNotMatch(stub, /concurrency/u, file);
    assert.ok(readme.includes(shown.trim()), `README.md shows ${file}`);
  }
  // Together they cover every event the reusable workflow handles.
  const types = Object.values(stubs).flatMap((s) => s.types.split(', '));
  assert.deepEqual([...types].sort(), ['edited', 'labeled', 'opened', 'ready_for_review', 'reopened', 'synchronize']);
});

// The human gate's stubs: a review only finishes a workflow that holds no
// token, and its completion runs the gate from the default branch.
test('the human gate stubs run the gate from the base for reviews and its label', () => {
  const readme = readRepo('README.md').replaceAll(/^ {3}/gmu, '');
  const approvals = readRepo('.github/workflows/pr-ai-review-approvals.yml');
  const human = readRepo('.github/workflows/pr-ai-review-human.yml');
  for (const stub of [approvals, human]) {
    const shown = stub.slice(stub.indexOf('\nname: ') + 1);
    assert.ok(readme.includes(shown.trim()), shown.split('\n')[0]);
    assert.match(stub, /\npermissions: \{\}\n/u);
    assert.doesNotMatch(stub, /concurrency|secrets|id-token|actions\/checkout/u);
  }
  const name = approvals.match(/\nname: (.*)\n/u)[1];
  assert.match(approvals, /\non:\n {2}pull_request_review:\n {4}types: \[submitted, dismissed\]\n/u);
  assert.doesNotMatch(approvals, /uses:|permissions:\n {6}/u);
  assert.match(
    human,
    new RegExp(
      `\\n {2}workflow_run:\\n {4}workflows: \\[${name.replaceAll(/[()]/gu, '\\$&')}\\]\\n {4}types: \\[completed\\]\\n`,
      'u',
    ),
  );
  assert.match(human, /\n {2}pull_request_target:\n {4}branches: \[main\]\n {4}types: \[labeled, unlabeled\]\n/u);
  assert.ok(
    human.includes(
      `\njobs:\n  human-gate:\n    if: github.event_name == 'workflow_run' || github.event.label.name == '${humanLabel}'\n    uses: Kong/volcano-actions/.github/workflows/ai-review-human.yml@main\n`,
    ),
  );
  assert.match(human, /\n {4}permissions:\n {6}contents: read\n {6}pull-requests: write\n {6}statuses: write\n$/u);
});
