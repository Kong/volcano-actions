# volcano-actions

Shared GitHub Actions and reusable workflows for Volcano repositories. The
`guided-review` and `pr-review` skills that the AI review mentions live in
[`Kong/volcano-conventions`](https://github.com/Kong/volcano-conventions).

## AI review

`.github/workflows/ai-review.yml` reviews each push to a same-repository pull
request with several AI reviewers and reports one `ai-review/verdict` commit
status on the reviewed head. P0-P2 findings fail it; a human collaborator with
write or admin access, including the PR author, can accept one head with the
`ai-review-override` label. This includes fork PRs, which the AI review does
not run on. The label is removed after processing. Each new commit needs its
own override. Volcano repositories call it instead of keeping their own copy,
so a fix lands once.

### Reviewers

Each reviewer is a job in `ai-review.yml` that runs one provider: today Claude
(the `claude` job) and OpenAI's Codex (the `codex` job). They review the same
head from the same inputs, under one policy and output schema that ship with
the action as `.github/actions/ai-review/policy.md` and `schema.json`.

- The action's `prepare` step builds the inputs in a checkout of the base
  branch: the diff, commit messages, description, and inline comments; a
  checkout of the head without its `AGENTS.md`, `CLAUDE.md`, `.claude/`, and
  `.mcp.json` files; the base's instruction files that govern the changed
  paths; and the reviewer candidates. Its outputs give the reviewer the policy,
  with the caller's `focus` applied, and the schema, along with a copy without
  `maxLength` for providers whose structured outputs reject it.
- Each job adds only what its provider needs: how it reads files and returns
  its verdict, and its own hardening. Claude reads the checkouts with no shell.
  Codex reads them in a read-only sandbox with no network, after the job drops
  the checkout's credentials. No reviewer job holds a write token; the verdict
  job posts the comments.

One verdict combines every reviewer, and the summary comment reads as a
single review that names no reviewer or provider, however many ran:

- A P0-P2 finding from any reviewer fails it. Any reviewer can ask for a
  person.
- The comment lists every reviewer's findings once, by title. Each finding on
  a line also gets an inline comment that explains why it matters, with a
  footer naming the model that found it, so two models reporting the same
  problem leave two comments.
- When a provider has an outage or its review otherwise does not complete, the
  other reviewers' verdict stands, and the run log warns which one is missing.
  When none completes, the verdict is an error and the head waits for a
  person, as described below.

To add a provider, change only the workflow; the verdict reads any number of
reviewers:

1. Add a job to `ai-review.yml` like `claude` and `codex`. It requires its
   credential, checks out the base, runs the action with `step: prepare`, and then
   runs the provider with prepare's `policy` and `schema` (or
   `schema-without-max-length`) and its own prompt lines. Its outputs are
   `reviewer`, the name the run log uses; `model`, the model its inline
   comments name; `findings`, its structured output; and `candidates`, from
   prepare.
2. List the job in the `verdict` job's `needs`.
3. Add its credential to the workflow's secrets, with `required: false`, and
   to the caller stubs below.
4. Add the job to the provider list in
   `.github/actions/ai-review/reviewer-jobs.test.cjs`, whose tests hold every
   reviewer job to these rules.

### Human review

It also reports `ai-review/human`, which says whether the head still needs a
person's review. It waits for one when:

- A reviewer judges the change risky: one that cannot be undone, moves a trust
  boundary (including a new third-party dependency, or CI or review
  configuration that gains access or weakens a check), breaks a contract
  others rely on, changes billing or pricing, does something its description
  does not explain, or could not be reviewed closely. No kind of file needs a
  person by itself; simple, low-risk changes pass whatever they touch.
- The change touches a path the repository lists in `human_review_paths`.
- Someone adds the `needs-human-review` label.
- The verdict was overridden, or the PR comes from a fork.

It passes when none applies, or once a collaborator with write access other
than the author approves. Like the repositories' required approvals today, an
approval carries across later pushes. Changes requested by a collaborator
with write access hold it until they approve or their review is dismissed.
The summary comment lists each reason as a question for the person to decide,
and what the reviews could not check, such as behavior only running the code
shows. When the reviews found nothing blocking, each read the whole change
closely, and each that asked for a person gave its own reasons, the comment
says the code needs no second review for bugs, and the marker that ends it
records `cleared`. It never says so for a path in `human_review_paths`, or for
a PR labeled `needs-human-review` when the review publishes. The
`guided-review` skill reads the marker, the labels, and `ai-review/human`, so a
label added later still counts. It walks the reviewer through those decisions,
runs `pr-review` only when the code is not cleared, and posts their answers,
once they confirm, as their review of that commit.
Requiring this status instead of an approval lets a PR merge on the AI review
alone when nothing needs a person.

If no review completes, for example during an outage of every provider, the
verdict is an error and the head needs a human review. An approval of that
exact commit by a collaborator with write access other than the author stands
in for the review and passes both statuses; an approval of an earlier commit
does not, since nobody read the new one. A verdict with findings still takes a
fix or the override label.

When it waits, the review requests one collaborator by name: the first
reviewer's pick among the people with write access and recent commits to the
changed files, falling back to whoever has the most, unless someone was
already requested by name or has reviewed. A team request, such as from
CODEOWNERS, does not count, so a repository that opts in can drop a catch-all
CODEOWNERS line.

### Setup

To add it to a repository:

1. Make the `ANTHROPIC_CI_API_KEY` and `CODEX_CI_ACCESS_TOKEN` secrets
   available to the repository's Actions, as organization or repository
   secrets. The stubs below pass them to the review, which calls Claude with
   the API key and runs Codex with the ChatGPT workspace access token.
2. Protect `main` and require the `ai-review/verdict` status on it, with
   GitHub Actions as the expected source. Otherwise anyone with write access
   can satisfy it by posting a status with their own token.
3. Create the `ai-review-override` label with the description:
   "Accept this head's AI review (write access, PR author included)".
   Create the `needs-human-review` label with the description:
   "Hold this PR for a human review, whatever the AI review decides".
4. Add `.github/workflows/ai-review.yml`:

   ```yaml
   name: AI Review

   on:
     pull_request_target:
       branches: [main]
       types: [opened, synchronize, reopened, ready_for_review]

   permissions: {}

   jobs:
     ai-review:
       uses: Kong/volcano-actions/.github/workflows/ai-review.yml@main
       permissions:
         contents: read
         pull-requests: write
         statuses: write
       secrets:
         anthropic_api_key: ${{ secrets.ANTHROPIC_CI_API_KEY }}
         codex_access_token: ${{ secrets.CODEX_CI_ACCESS_TOKEN }}
   ```

   And `.github/workflows/ai-review-retarget-override.yml`:

   ```yaml
   name: AI Review (retarget and override)

   on:
     pull_request_target:
       branches: [main]
       types: [edited, labeled]

   permissions: {}

   jobs:
     retarget-or-override:
       if: github.event.changes.base || github.event.label.name == 'ai-review-override'
       uses: Kong/volcano-actions/.github/workflows/ai-review.yml@main
       permissions:
         contents: read
         pull-requests: write
         statuses: write
       secrets:
         anthropic_api_key: ${{ secrets.ANTHROPIC_CI_API_KEY }}
         codex_access_token: ${{ secrets.CODEX_CI_ACCESS_TOKEN }}
   ```

   Every title, body, or label edit fires `edited` or `labeled`. The PR page
   shows only the newest run of each check, so in the first workflow those
   runs, with every job skipped, would hide the review. Keep the two
   workflows' names and job IDs distinct.

   Grant every permission shown; a called workflow cannot raise them. Do not
   add `concurrency`: the called workflow sets its own group, and a matching
   caller group deadlocks it. Both workflows share that group, so a retarget
   still cancels a review of the old base.

   For `ai-review/human` to follow reviews and the `needs-human-review`
   label, add `.github/workflows/ai-review-approvals.yml`:

   ```yaml
   name: AI Review (approvals)

   on:
     pull_request_review:
       types: [submitted, dismissed]

   permissions: {}

   jobs:
     # A review runs the PR's own copy of this workflow, so it only finishes;
     # AI Review (human gate) then runs from the default branch.
     reviewed:
       runs-on: ubuntu-latest
       timeout-minutes: 5
       steps:
         - run: echo "AI Review (human gate) re-sets ai-review/human."
   ```

   And `.github/workflows/ai-review-human.yml`:

   ```yaml
   name: AI Review (human gate)

   on:
     workflow_run:
       workflows: [AI Review (approvals)]
       types: [completed]
     pull_request_target:
       branches: [main]
       types: [labeled, unlabeled]

   permissions: {}

   jobs:
     human-gate:
       if: github.event_name == 'workflow_run' || github.event.label.name == 'needs-human-review'
       uses: Kong/volcano-actions/.github/workflows/ai-review-human.yml@main
       permissions:
         contents: read
         pull-requests: write
         statuses: write
   ```

   A review event runs the PR's own copy of its workflow, so the first does
   nothing; `workflow_run` runs the second from the default branch, where the
   PR cannot change it. Keep the first workflow's name as the second lists it.

5. If the repository uses a merge queue, add
   `.github/workflows/ai-review-merge-queue.yml`, so merge-group commits
   pass the required statuses:

   ```yaml
   name: AI Review (merge queue)

   on:
     merge_group:
       branches: [main]
       types: [checks_requested]

   permissions: {}

   jobs:
     pass:
       uses: Kong/volcano-actions/.github/workflows/ai-review-merge-queue.yml@main
       permissions:
         statuses: write
   ```

6. To merge on the AI review alone when nothing needs a person, first watch
   the summary comments' **Human review** lines for a while with approvals
   still required. Then, in the ruleset for `main`, require the
   `ai-review/human` status with GitHub Actions as the expected source, and
   set required approvals to 0.

The status guards against mistakes, not against collaborators with write
access, who can already post a status through a workflow on their own branch
or edit the summary comment it reads.

The reviewers read the repository's base-branch `AGENTS.md` and `CLAUDE.md`,
so keep repository rules there. MCP servers in the repository's `.mcp.json`
do not run in the review. For review emphasis those files do not cover,
or for other bots, pass inputs. Pass the same ones in both `ai-review.yml`
and `ai-review-retarget-override.yml`, since a retarget reviews the PR again:

```yaml
jobs:
  ai-review:
    # uses, permissions, and secrets as above
    with:
      focus: |
        - Accessibility regressions in rendered components
      human_review_paths: |
        **/migrations/**
        infra/prod/**
      allowed_bots: dependabot[bot],renovate[bot]
```

`human_review_paths` takes one glob per line, matched against paths from the
repository root: `*` stays within a directory, `**/` spans any number of them,
and lines starting with `#` are comments.

### Changing the review

Callers using `@main` receive workflow changes when they merge here. Callers
pinned to a workflow SHA need a reference update. The workflows pin the
composite action to a full commit SHA, so action changes, including the
policy and schema that ship with it, do not roll out until every reference to
it in `ai-review.yml` and `ai-review-human.yml` is updated.

For action changes, merge the implementation first. In a separate PR, update
the workflows' action pins to the resulting commit on `main`, using the squash
commit when applicable. Never pin an unmerged PR commit: CI fetches `main`'s
history to test the pinned action, and checks its severities against its own
schema. Before pushing, run:

```sh
npm test
```
