'use strict';

// The workflow context and the github-script core that the ai-review steps
// receive, as fakes for the tests.

// The head SHA every fake PR has.
const sha = 'abcdef1234567890';

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
  privateRepo = true,
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
      repository: { private: privateRepo },
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
    info: () => {},
    warning: (message) => warnings.push(message),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
  };
}

module.exports = { sha, context, core };
