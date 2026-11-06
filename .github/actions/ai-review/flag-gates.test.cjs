'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { humanStatusContext, publish } = require('./ai-review.cjs');
const { policy, schemas } = require('./prepare.cjs');
const { scopeOf, selfApproverOf } = require('./self-approval.cjs');
const { addedLines } = require('./flag-gates.cjs');
const { output, claudeReviews, clearAfter, context, core } = require('./test-helpers.cjs');
const { client, passing, useSelfApprovers } = require('./self-approval-fakes.cjs');

const flagged = ['*, behind a feature flag: feature work behind a flag', 'octocat: a change only to styling'].join(
  '\n',
);
const page = [
  'import { New } from "./new";',
  'const { "beta": on } = useFeatureFlags();',
  'if (!on) return null;',
  'return <New />;',
];
const edited = {
  filename: 'src/page.tsx',
  status: 'modified',
  patch: '@@ -3,1 +3,2 @@\n if (!on) return null;\n+return <New />;',
};
const gate = { path: 'src/page.tsx', line: 2, flag: 'beta' };
const cleared = (within, gates = [gate]) => ({ needed: false, reasons: [], within, flag_gates: gates });

function useFlags(t, check = 'useFeatureFlags|requireFeature') {
  useSelfApprovers(t, flagged);
  process.env.FEATURE_FLAG_CHECK = check;
  clearAfter(t, 'FEATURE_FLAG_CHECK');
}

// Publishes a review of monalisa's PR, or `author`'s, that clears it with
// `human`, and returns its human status and whether the review approved it.
async function publishFlagged(t, human, { files = [edited], author = 'monalisa', failContent = false } = {}) {
  claudeReviews(t, 'success', output([], 'Adds the new page behind beta.', human));
  const c = client({ author, statuses: passing, files });
  c.github.rest.repos.getContent = (args) => {
    c.calls.push({ ...args, call: 'getContent' });
    if (failContent || args.path !== 'src/page.tsx') return Promise.reject(new Error('Not Found'));
    return Promise.resolve({ data: { encoding: 'base64', content: Buffer.from(page.join('\n')).toString('base64') } });
  };
  await publish({ github: c.github, context: context({ author }), core: core() });
  return { status: c.set(humanStatusContext)[0][2], approved: c.named('createReview').length === 1 };
}

test('a change behind a feature flag merges on a cited check the PR did not add', async (t) => {
  useFlags(t);
  assert.deepEqual(await publishFlagged(t, cleared(1)), { status: 'No human review needed.', approved: true });
  // A case not behind a flag needs no citation.
  assert.deepEqual(await publishFlagged(t, cleared(1, []), { author: 'octocat' }), {
    status: 'No human review needed.',
    approved: true,
  });
});

test('a citation that does not hold needs a person, whatever the review decided', async (t) => {
  useFlags(t);
  const added = {
    ...edited,
    patch: '@@ -1,1 +1,2 @@\n import { New } from "./new";\n+const { "beta": on } = useFeatureFlags();',
  };
  for (const [why, human, options, reason] of [
    ['no case named', { needed: false, reasons: [] }, {}, /did not say which change monalisa may merge/u],
    ['case out of range', cleared(2), {}, /did not say which change/u],
    ['no check cited', cleared(1, []), {}, /cited no feature flag check/u],
    [
      'not a check',
      cleared(1, [{ ...gate, line: 3 }]),
      {},
      /src\/page\.tsx:3 as a check of the beta feature flag, but it is not one/u,
    ],
    ['another flag', cleared(1, [{ ...gate, flag: 'gamma' }]), {}, /not one/u],
    ['past the end', cleared(1, [{ ...gate, line: 9 }]), {}, /not one/u],
    ['incomplete', cleared(1, [{ path: 'src/page.tsx', line: 2 }]), {}, /without its file, line, and flag/u],
    ['check added', cleared(1), { files: [added] }, /Adds or changes the check of the beta feature flag/u],
    ['new file', cleared(1), { files: [{ ...edited, status: 'added' }] }, /Adds or changes the check/u],
    ['no patch', cleared(1), { files: [{ ...edited, patch: undefined }] }, /Adds or changes the check/u],
    ['unread', cleared(1), { failContent: true }, /Could not read src\/page\.tsx:2/u],
  ]) {
    const { status, approved } = await publishFlagged(t, human, options);
    assert.match(status, reason, why);
    assert.equal(approved, false, why);
  }
  // A line naming the flag that is not the repository's check is not one.
  process.env.FEATURE_FLAG_CHECK = 'requireFeature';
  assert.match((await publishFlagged(t, cleared(1))).status, /but it is not one/u);
  // A repository that names no check verifies nothing, so nothing holds.
  process.env.FEATURE_FLAG_CHECK = '';
  assert.match((await publishFlagged(t, cleared(1))).status, /names no feature flag check/u);
});

test('the patch gives the head lines a PR adds or changes', () => {
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    '\\ No newline at end of file',
    '@@ -10,2 +10,3 @@',
    ' x',
    '+y',
    '+z',
  ];
  assert.deepEqual([...addedLines(patch.join('\n'))], [2, 11, 12]);
});

test('only a scope behind a feature flag asks for the case and its checks', (t) => {
  useSelfApprovers(t, `${flagged}\nhubot, behind a feature flag`);
  const monalisa = { login: 'monalisa', type: 'User' };
  assert.deepEqual(selfApproverOf(monalisa).flagged, ['feature work behind a flag']);
  assert.equal(scopeOf(monalisa), 'feature work behind a flag (behind a feature flag)');
  // A line behind a flag with no scope names nobody.
  assert.equal(selfApproverOf({ login: 'hubot', type: 'Bot' }), null);

  assert.match(
    policy(context({ author: 'octocat' }), '/in'),
    /one of:\n1\. a change only to styling\n2\. feature work behind a flag \(behind a feature flag\)\nAnything else needs a person.*\nSet human_review\.within to the number/su,
  );
  const fields = (author) =>
    Object.keys(JSON.parse(schemas({ login: author, type: 'User' }).schema).properties.human_review.properties);
  assert.deepEqual(fields('octocat').slice(-2), ['within', 'flag_gates']);
  assert.deepEqual(
    JSON.parse(schemas({ login: 'octocat', type: 'User' }).schema).properties.human_review.required.slice(-2),
    ['within', 'flag_gates'],
  );
  // Without a scope behind a flag, the schema is the shared one.
  useSelfApprovers(t, 'octocat: a change only to styling');
  assert.deepEqual(schemas({ login: 'octocat', type: 'User' }), schemas());
  assert.doesNotMatch(policy(context({ author: 'octocat' }), '/in'), /within/u);
});
