'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const review = require('./ai-review.cjs');
const { readRepo } = require('./test-helpers.cjs');

const yml = () => readRepo('.github/actions/ai-review/action.yml');
const stepsOf = (text) =>
  text
    .split('\n  steps:\n')[1]
    .replaceAll(/^ {4}#.*\n/gmu, '')
    .split(/\n(?= {4}- )/u);

test('the action pins every action it uses to a full commit SHA', () => {
  const refs = [...yml().matchAll(/\buses: ([^\s#]+)/gu)].map((match) => match[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.match(ref, /^[^@]+@[a-f0-9]{40}$/u, ref);
});

test('the action runs only the exported steps and passes inputs through env', () => {
  const text = yml();
  assert.match(text, /\n {2}using: composite\n/u);
  assert.match(text, /AI_REVIEW_SCRIPT: \$\{\{ github\.action_path \}\}\/ai-review\.cjs\n/u);
  const script = text.split('script: |\n')[1];
  assert.doesNotMatch(script, /\$\{\{/u);
  const allowed = JSON.parse(script.match(/\[('prepare'.*?)\]/u)[0].replaceAll("'", '"'));
  assert.deepEqual(allowed, ['prepare', 'start', 'publish', 'override', 'gate']);
  for (const step of allowed) assert.equal(typeof review[step], 'function', step);
});

test('prepare runs its shell script first, from the action, with inputs in env', () => {
  const [shell, script] = stepsOf(yml());
  assert.match(shell, /^ {4}- if: inputs\.step == 'prepare'\n {6}shell: bash\n/u);
  const run = shell.match(/\n {6}run: (.*)\n?$/u)[1];
  assert.equal(run, 'bash "$GITHUB_ACTION_PATH/prepare.sh"');
  for (const name of ['GH_TOKEN', 'REPO', 'PR_NUMBER', 'BASE_SHA', 'HEAD_SHA', 'INPUTS']) {
    assert.match(shell, new RegExp(`\\n {8}${name}: \\$\\{\\{ [^}]+ \\}\\}`, 'u'), name);
  }
  // The script step reads the inputs prepare.sh wrote, from the same place.
  const inputs = (step) => step.match(/\n {8}INPUTS: (.*)\n/u)[1];
  assert.equal(inputs(script), inputs(shell));
  assert.match(script, /^ {4}- id: run\n {6}uses: actions\/github-script@/u);
});

test("the action's outputs are the script step's, under the same names", () => {
  const outputs = yml().split('\noutputs:\n')[1].split('\nruns:\n')[0];
  const names = [...outputs.matchAll(/^ {2}([a-z-]+):\n/gmu)].map((match) => match[1]);
  assert.deepEqual(names, ['review', 'inputs', 'candidates', 'policy', 'schema', 'schema-without-max-length']);
  for (const name of names) {
    assert.ok(outputs.includes(`\n    value: \${{ steps.run.outputs.${name} }}\n`), name);
  }
});
