'use strict';

// Fakes for the self-approval tests (see self-approval.cjs).

const { statusContext, publish } = require('./ai-review.cjs');
const { selfApprovalMarker } = require('./self-approval.cjs');
const {
  sha,
  output,
  routine,
  decided,
  claudeReviews,
  clearAfter,
  client: baseClient,
  context,
  core,
} = require('./test-helpers.cjs');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// The shared client, with the review writes this feature makes, which fail
// when `failApprove` or `failDismiss` is set. A dismissal shows in later reads
// of the reviews, and the timeline lists `timeline`, or fails with
// `failTimeline`.
function client({ failApprove = false, failDismiss = false, timeline = [], failTimeline = false, ...options } = {}) {
  const reviews = options.reviews?.map((r) => ({ ...r }));
  const c = baseClient({ ...options, ...(reviews && { reviews }) });
  const write =
    (call, failure, then = () => {}) =>
    (args) => {
      c.calls.push({ ...args, call });
      if (failure) return Promise.reject(httpError(...failure));
      then(args);
      return Promise.resolve({ data: {} });
    };
  const { rest, paginate } = c.github;
  rest.pulls.createReview = write('createReview', failApprove && ['Unprocessable Entity', 422]);
  rest.pulls.dismissReview = write('dismissReview', failDismiss && ['Forbidden', 403], (args) => {
    const r = reviews?.find((g) => g.id === args.review_id);
    if (r) r.state = 'DISMISSED';
  });
  rest.issues.listEventsForTimeline = () => {};
  c.github.paginate = (method, args) => {
    if (method !== rest.issues.listEventsForTimeline) return paginate(method, args);
    c.calls.push({ ...args, call: 'listEventsForTimeline' });
    return failTimeline ? Promise.reject(httpError('Server Error', 500)) : Promise.resolve(timeline);
  };
  return c;
}

const passing = [
  { context: statusContext, state: 'success', description: 'No P0-P2 findings (0 P3, 0 pre-existing).' },
];
// An approval this review gave, of `commit`.
const selfApproval = (commit = sha, id = 31) => ({
  id,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  state: 'APPROVED',
  commit_id: commit,
  body: `${selfApprovalMarker}\nThe AI review found nothing.`,
});

const approvers = [
  'octocat: a change only to styling',
  'hubot, reviewed by octocat: a change only to user-facing copy',
].join('\n');

const useSelfApprovers = (t, entries = approvers) => {
  process.env.SELF_APPROVERS = entries;
  clearAfter(t, 'SELF_APPROVERS');
};

// Publishes a review with this human decision and findings for the author.
async function publishFor(t, { human = routine, findings = [], candidates, ...options } = {}) {
  claudeReviews(t, 'success', output(findings, 'Edits the hero copy.', human), candidates);
  const c = client({ author: 'octocat', statuses: passing, ...options });
  const k = core();
  await publish({ github: c.github, context: context({ author: options.author ?? 'octocat' }), core: k });
  return { c, k };
}

// The summary comment of a review that cleared the head and weighed `scope`,
// octocat's by default.
function decidedWithin(scope = 'a change only to styling') {
  const comment = decided([]);
  const body = comment.body.replace(/<!-- ai-review-human (\S+) -->$/u, (_, encoded) => {
    const decision = { ...JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), scope };
    return `<!-- ai-review-human ${Buffer.from(JSON.stringify(decision)).toString('base64')} -->`;
  });
  return { ...comment, body };
}

module.exports = { client, passing, selfApproval, approvers, useSelfApprovers, publishFor, decidedWithin };
