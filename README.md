# volcano-actions

Shared GitHub Actions and reusable workflows for Volcano repositories. The
`guided-review` and `pr-review` skills that the Claude review mentions live in
[`Kong/volcano-conventions`](https://github.com/Kong/volcano-conventions).

## Claude review

`.github/workflows/claude-review.yml` reviews each push to a same-repository
pull request with Claude and reports the `claude-review/verdict` commit status
on the reviewed head. P0-P2 findings fail it; a human collaborator with write or
admin access, including the PR author, can accept one head with the
`claude-review-override` label. This includes fork PRs, which Claude does not
review. The label is removed after processing. Each new commit needs its own
override. Volcano repositories call it instead of keeping their own copy, so a
fix lands once.

It also reports `claude-review/human`, which says whether the head still needs
a person's review. It waits for one when:

- Claude judges the change risky: one that cannot be undone, moves a trust
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
and what the review could not check, such as behavior only running the code
shows. When Claude found nothing blocking, read the whole change closely, and
gave its own reasons, the comment says the code needs no second review for
bugs, and the marker that ends it records `cleared`. It never says so for a
path in `human_review_paths`, or for a PR labeled `needs-human-review` when the
review publishes. The `guided-review` skill reads the marker, the labels, and
`claude-review/human`, so a label added later still counts. It walks the
reviewer through those decisions, runs `pr-review` only when the code is not
cleared, and posts their answers, once they confirm, as their review of that
commit.
Requiring this status instead of an approval lets a PR merge on Claude's review
alone when nothing needs a person.

If Claude's review does not complete, for example during an outage, the
verdict is an error and the head needs a human review. An approval of that
exact commit by a collaborator with write access other than the author stands
in for the review and passes both statuses; an approval of an earlier commit
does not, since nobody read the new one. A verdict with findings still takes a
fix or the override label.

When it waits, the review requests one collaborator by name: Claude's pick
among the people with write access and recent commits to the changed files,
falling back to whoever has the most, unless someone was already requested by
name or has reviewed. A team request, such as from CODEOWNERS, does not count,
so a repository that opts in can drop a catch-all CODEOWNERS line.

To add it to a repository:

1. Add the repository to `team-volcano` in
   [`Kong/ksai` federations](https://github.com/Kong/ksai/blob/main/federations/team-volcano.yaml).
   The federation mints only for listed repositories and protected branches.
2. Protect `main` and require the `claude-review/verdict` status on it, with
   GitHub Actions as the expected source. Otherwise anyone with write access
   can satisfy it by posting a status with their own token.
3. Create the `claude-review-override` label with the description:
   "Accept this head's Claude review (write access, PR author included)".
   Create the `needs-human-review` label with the description:
   "Hold this PR for a human review, whatever Claude decides".
4. Add `.github/workflows/claude-review.yml`:

   ```yaml
   name: Claude Review

   on:
     pull_request_target:
       branches: [main]
       types: [opened, synchronize, reopened, ready_for_review]

   permissions: {}

   jobs:
     claude-review:
       uses: Kong/volcano-actions/.github/workflows/claude-review.yml@main
       permissions:
         contents: read
         id-token: write
         pull-requests: write
         statuses: write
   ```

   And `.github/workflows/claude-review-retarget-override.yml`:

   ```yaml
   name: Claude Review (retarget and override)

   on:
     pull_request_target:
       branches: [main]
       types: [edited, labeled]

   permissions: {}

   jobs:
     retarget-or-override:
       if: github.event.changes.base || github.event.label.name == 'claude-review-override'
       uses: Kong/volcano-actions/.github/workflows/claude-review.yml@main
       permissions:
         contents: read
         id-token: write
         pull-requests: write
         statuses: write
   ```

   Every title, body, or label edit fires `edited` or `labeled`. The PR page
   shows only the newest run of each check, so in the first workflow those
   runs, with every job skipped, would hide the review. Keep the two
   workflows' names and job IDs distinct.

   Grant every permission shown; a called workflow cannot raise them. Do not
   add `concurrency`: the called workflow sets its own group, and a matching
   caller group deadlocks it. Both workflows share that group, so a retarget
   still cancels a review of the old base.

   For `claude-review/human` to follow reviews and the `needs-human-review`
   label, add `.github/workflows/claude-review-approvals.yml`:

   ```yaml
   name: Claude Review (approvals)

   on:
     pull_request_review:
       types: [submitted, dismissed]

   permissions: {}

   jobs:
     # A review runs the PR's own copy of this workflow, so it only finishes;
     # Claude Review (human gate) then runs from the default branch.
     reviewed:
       runs-on: ubuntu-latest
       timeout-minutes: 5
       steps:
         - run: echo "Claude Review (human gate) re-sets claude-review/human."
   ```

   And `.github/workflows/claude-review-human.yml`:

   ```yaml
   name: Claude Review (human gate)

   on:
     workflow_run:
       workflows: [Claude Review (approvals)]
       types: [completed]
     pull_request_target:
       branches: [main]
       types: [labeled, unlabeled]

   permissions: {}

   jobs:
     human-gate:
       if: github.event_name == 'workflow_run' || github.event.label.name == 'needs-human-review'
       uses: Kong/volcano-actions/.github/workflows/claude-review-human.yml@main
       permissions:
         contents: read
         pull-requests: write
         statuses: write
   ```

   A review event runs the PR's own copy of its workflow, so the first does
   nothing; `workflow_run` runs the second from the default branch, where the
   PR cannot change it. Keep the first workflow's name as the second lists it.

5. If the repository uses a merge queue, add
   `.github/workflows/claude-review-merge-queue.yml`, so merge-group commits
   pass the required statuses:

   ```yaml
   name: Claude Review (merge queue)

   on:
     merge_group:
       branches: [main]
       types: [checks_requested]

   permissions: {}

   jobs:
     pass:
       uses: Kong/volcano-actions/.github/workflows/claude-review-merge-queue.yml@main
       permissions:
         statuses: write
   ```

6. To merge on Claude's review alone when nothing needs a person, first watch
   the summary comments' **Human review** lines for a while with approvals
   still required. Then, in the ruleset for `main`, require the
   `claude-review/human` status with GitHub Actions as the expected source,
   and set required approvals to 0.

The status guards against mistakes, not against collaborators with write
access, who can already post a status through a workflow on their own branch
or edit the summary comment it reads.

The reviewer reads the repository's base-branch `AGENTS.md` and `CLAUDE.md`,
so keep repository rules there. MCP servers in the repository's `.mcp.json`
do not run in the review. For review emphasis those files do not cover,
or for other bots, pass inputs. Pass the same ones in both
`claude-review.yml` and `claude-review-retarget-override.yml`, since a
retarget reviews the PR again:

```yaml
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

A repository outside the team-volcano federation, such as this one, can skip
step 1 and pass an Anthropic API key from a repository secret in both
workflows instead:

```yaml
    secrets:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The review then authenticates with the key instead of the federation.

Callers using `@main` receive workflow changes when they merge here. Callers
pinned to a workflow SHA need a reference update. The workflow pins its nested
composite action to a full commit SHA, so action changes do not roll out until
all five action references are updated, four in `claude-review.yml` and one
in `claude-review-human.yml`.

For action changes, merge the implementation first. In a separate PR, update
the workflow's action pins to the resulting commit on `main`, using the squash
commit when applicable. Never pin an unmerged PR commit: CI fetches `main`'s
history to test the pinned verdict.

For severity additions, removals, or renames, first merge and unit-test the action
change while retaining the existing workflow pin and schema. Then update the
pins and schema together. The test suite checks the deployed severity vocabulary
independently of the current action's unit tests. Before pushing, run:

```sh
npm test
```
