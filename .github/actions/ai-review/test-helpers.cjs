'use strict';

// Fixtures and GitHub fakes shared by the ai-review tests.

const fs = require('node:fs');
const path = require('node:path');
const { marker } = require('./ai-review.cjs');
const { tempDir } = require('./test-git.cjs');

const root = path.join(__dirname, '../../..');
const readRepo = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sha = 'abcdef1234567890';
const url = 'https://github.com/Kong/volcano-hosting/actions/runs/9';
const finding = (severity, overrides = {}) => ({
  severity,
  path: 'internal/a.go',
  line: 12,
  title: 'Nil map write',
  ...overrides,
});
const output = (findings, summary = 'Adds a cache.', human) =>
  JSON.stringify({ summary, findings, ...(human && { human_review: human }) });
const routine = { needed: false, reasons: [] };
// A review's structured output in the full shape schema.json describes.
const reviewJson = ({
  summary = 'Adds a cache.',
  findings = [],
  human = routine,
  notChecked = [],
  closely = true,
} = {}) =>
  JSON.stringify({ summary, findings, human_review: human, not_checked: notChecked, reviewed_closely: closely });

// Deletes the named action inputs after the test that sets them.
const clearAfter = (t, ...names) =>
  t.after(() => {
    for (const name of names) delete process.env[name];
  });

// The verdict job's `toJSON(needs)` for reviewers given as
// [name, result, output, candidates, model], each in a job of its own.
const needsOf = (...reviewers) =>
  JSON.stringify(
    Object.fromEntries(
      reviewers.map(([name, result, , candidates = '', model = ''], i) => [
        `job${i}`,
        { result, outputs: { reviewer: name, model, candidates } },
      ]),
    ),
  );
// Hands publish these reviewers as the verdict job does: their `needs` in
// REVIEWS, and each structured output as its job's file in REVIEW_OUTPUTS.
// An empty output writes no file.
function useReviews(t, ...reviewers) {
  const dir = tempDir(t, 'ai-review-outputs-');
  reviewers.forEach(([, , json], i) => {
    if (json) fs.writeFileSync(path.join(dir, `ai-review-job${i}.json`), json);
  });
  process.env.REVIEWS = needsOf(...reviewers);
  process.env.REVIEW_OUTPUTS = dir;
  clearAfter(t, 'REVIEWS', 'REVIEW_OUTPUTS');
}
// The same with Claude as the only reviewer.
const claudeReviews = (t, result, json, candidates) => useReviews(t, ['Claude', result, json, candidates]);
const review = (login, state, type = 'User', commit = sha) => ({ user: { login, type }, state, commit_id: commit });
// The summary comment as publish leaves it for a head it decided.
const decided = (reasons, head = sha, reviewer = null) => ({
  id: 2,
  user: { login: 'github-actions[bot]' },
  body: `${marker}\n### AI review: no P0-P2 findings\n\n<!-- ai-review-human ${Buffer.from(JSON.stringify({ sha: head, reasons, reviewer })).toString('base64')} -->`,
});

const httpError = (message, status) => Object.assign(new Error(message), { status });

// Answers like an Octokit method: always a promise, which a throw rejects.
const endpoint =
  (fn) =>
  (...args) =>
    new Promise((resolve) => {
      resolve(fn(...args));
    });

const clientDefaults = () => ({
  comments: [],
  permission: 'write',
  permissions: {},
  statuses: [],
  liveHead: sha,
  liveBase: 'main',
  state: 'open',
  associated: [],
  draft: false,
  failComments: false,
  reviews: [],
  files: [],
  failFiles: false,
  labels: [],
  headRepo: 'Kong/volcano-hosting',
  open: [],
  requested: [],
  requestedTeams: [],
  failRequest: false,
  failReviews: false,
  failStatuses: false,
  reviewComments: [],
  failReviewComments: false,
  // [message, status] to reject a review comment with, or null to accept it.
  rejectComment: () => null,
  commitAuthor: () => null,
});

// Makes endpoints that record each call by name before answering.
const recorder =
  (calls) =>
  (name, answer = () => ({ data: {} })) =>
    endpoint((args) => {
      calls.push({ ...args, call: name });
      return answer(args);
    });

const issuesApi = (record) => ({
  listComments: () => {},
  createComment: record('createComment'),
  updateComment: record('updateComment'),
  removeLabel: record('removeLabel'),
});

const livePull = (o, number) => ({
  number,
  draft: o.draft,
  state: o.state,
  labels: o.labels,
  user: { login: 'author' },
  requested_reviewers: o.requested,
  requested_teams: o.requestedTeams,
  head: { sha: o.liveHead, repo: o.headRepo && { full_name: o.headRepo } },
  base: { ref: o.liveBase },
});

const pullsApi = (o, record) => ({
  get: record('getPull', (args) => ({ data: livePull(o, args.pull_number) })),
  list: record('listPulls', () => ({ data: o.open })),
  listReviews: () => {},
  listFiles: () => {},
  listReviewComments: () => {},
  createReviewComment: record('createReviewComment', (args) => {
    const rejection = o.rejectComment(args);
    if (rejection) throw httpError(...rejection);
    return { data: {} };
  }),
  requestReviewers: record('requestReviewers', () => {
    if (o.failRequest) throw httpError('Validation Failed', 422);
    return { data: {} };
  }),
});

const reposApi = (o, record) => ({
  listPullRequestsAssociatedWithCommit: record('listPullRequestsAssociatedWithCommit', () => ({
    data: o.associated,
  })),
  createCommitStatus: record('createCommitStatus'),
  getCommit: record('getCommit', (args) => ({ data: { author: o.commitAuthor(args.ref) } })),
  getCollaboratorPermissionLevel: record('getCollaboratorPermissionLevel', (args) => {
    const level = Object.hasOwn(o.permissions, args.username) ? o.permissions[args.username] : o.permission;
    if (level === null) throw httpError('Not Found', 404);
    return { data: { permission: level } };
  }),
  getCombinedStatusForRef: record('getCombinedStatusForRef', () => {
    if (o.failStatuses) throw httpError('Server Error', 500);
    return { data: { statuses: o.statuses } };
  }),
});

// Lists reviews, files, review comments, or, for any other method, comments.
function paginator(o, rest, calls) {
  const list = (call, items, failure) => (args) => {
    calls.push({ ...args, call });
    if (failure) throw httpError(...failure);
    return items;
  };
  const lists = new Map([
    [rest.pulls.listReviews, list('listReviews', o.reviews, o.failReviews && ['Server Error', 500])],
    [rest.pulls.listFiles, list('listFiles', o.files, o.failFiles && ['Server Error', 500])],
    [
      rest.pulls.listReviewComments,
      list('listReviewComments', o.reviewComments, o.failReviewComments && ['Server Error', 500]),
    ],
  ]);
  const comments = list('listComments', o.comments, o.failComments && ['Validation Failed', 422]);
  return endpoint((method, args) => (lists.get(method) ?? comments)(args));
}

function client(options = {}) {
  const o = { ...clientDefaults(), ...options };
  const calls = [];
  const record = recorder(calls);
  const rest = { issues: issuesApi(record), pulls: pullsApi(o, record), repos: reposApi(o, record) };
  const github = { paginate: paginator(o, rest, calls), rest };
  const named = (call) => calls.filter((c) => c.call === call);
  // The statuses set for one context, as [sha, state, description].
  const set = (name) =>
    named('createCommitStatus')
      .filter((s) => s.context === name)
      .map((s) => [s.sha, s.state, s.description]);
  return { github, calls, named, set };
}

function context({
  sender = { login: 'reviewer', type: 'User' },
  author = 'author',
  headRepo = 'Kong/volcano-hosting',
  actor = 'author',
  action = 'synchronize',
  runAttempt = 1,
  draft = false,
  eventName = 'pull_request_target',
  workflowRun,
} = {}) {
  if (workflowRun) {
    return {
      eventName: 'workflow_run',
      actor,
      runAttempt,
      repo: { owner: 'Kong', repo: 'volcano-hosting' },
      serverUrl: 'https://github.com',
      runId: 9,
      payload: { workflow_run: workflowRun },
    };
  }
  return {
    eventName,
    actor,
    runAttempt,
    repo: { owner: 'Kong', repo: 'volcano-hosting' },
    serverUrl: 'https://github.com',
    runId: 9,
    payload: {
      action,
      sender,
      pull_request: {
        number: 7,
        draft,
        user: { login: author },
        base: { ref: 'main' },
        head: { sha, repo: headRepo && { full_name: headRepo } },
      },
    },
  };
}

function core() {
  const failures = [];
  const warnings = [];
  const notices = [];
  const outputs = {};
  return {
    failures,
    warnings,
    notices,
    outputs,
    setFailed: (message) => failures.push(message),
    notice: (message) => notices.push(message),
    warning: (message) => warnings.push(message),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
  };
}

module.exports = {
  root,
  readRepo,
  sha,
  url,
  finding,
  output,
  routine,
  reviewJson,
  needsOf,
  useReviews,
  claudeReviews,
  review,
  decided,
  clearAfter,
  client,
  context,
  core,
};
