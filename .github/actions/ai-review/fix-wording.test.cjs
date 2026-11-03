'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { publish } = require('./ai-review.cjs');
const { policy } = require('./prepare.cjs');
const { finding, reviewJson, useReviews, client, context, core } = require('./test-helpers.cjs');

// Words that describe a weakness, an attack, or what it reaches, rather than
// what a change does.
const weaknessWording = /\b(?:vulnerab|exploit|attack|bypass|spoof|leak|weakness|reachable|steal|exfiltrat)\w*/iu;

test('the policy has a security fix described by what it changes', () => {
  const text = policy(context(), '/runner/temp/ai-review');
  for (const part of [
    'Everything this review writes is posted on the PR.',
    '"compare connect target hosts exactly"',
    'Never name the weakness\nit closes, how to attack it, the data it would expose, or an input\nthat would get past the control.',
    'A security problem the change\nleaves or adds is still a finding at the level it deserves',
  ]) {
    assert.ok(text.includes(part), part);
  }
});

test('the schema asks for a security fix by what it changes', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
  assert.match(schema.properties.summary.description, /For a security fix, what it changes, never the weakness it closes\./u);
  assert.match(
    schema.properties.findings.items.properties.detail.description,
    /For a security problem, the control the code needs, never how to exploit it\./u,
  );
});

// A review of a change that fixes an origin check, comparing the host exactly
// where it compared a suffix, as the policy asks a reviewer to write it.
test("an origin-check fix's review publishes what changed and nothing about a weakness", async (t) => {
  const review = reviewJson({
    summary: 'Compares the request origin host exactly instead of by suffix. Low risk.',
    findings: [
      finding('p3', {
        path: 'internal/realtime/origin.go',
        line: 13,
        title: 'Name the allowed host in one constant',
        detail: 'Compare against one `allowedHost` constant so the check and its test share it.',
      }),
    ],
  });
  useReviews(t, ['Claude', 'success', review, '', 'claude-opus-5-5']);
  const c = client();

  await publish({ github: c.github, context: context(), core: core() });

  const posted = [
    ...c.named('createComment').map(({ body }) => body),
    ...c.named('createReviewComment').map(({ body }) => body),
  ];
  assert.ok(posted.some((body) => body.includes('Compares the request origin host exactly')), 'the summary is posted');
  assert.ok(posted.some((body) => body.includes('Name the allowed host in one constant')), 'the finding is posted');
  for (const body of posted) assert.doesNotMatch(body, weaknessWording);
});
