# Agent Instructions

Follow the team's [workflow standards](https://github.com/Kong/volcano-conventions/blob/main/.agents/skills/team-workflow/SKILL.md).

This repository is meant to be public. Keep account IDs, internal hostnames,
credentials, and internal-only process out of it.

When changing `.github/actions/ai-review` or the AI review workflows
(`.github/workflows/ai-review*.yml`), run `npm test`. Every Volcano
repository's review runs this repository's `main`, so keep changes compatible
with callers' stubs and update `README.md` when the stub changes.

The AI review runs one job per provider in `ai-review.yml` and combines them
in one verdict. The policy and output schema ship with the action
(`policy.md`, `schema.json`) and reach every reviewer through its `prepare`
step; a provider's job adds only how that provider reads and returns its
verdict, and the verdict job posts every reviewer's comments. The verdict code reads any number of reviewers from the
`verdict` job's `needs`, so adding a provider changes only the workflow, its
secrets, and the reviewer-job tests. `README.md` lists the steps. Name a
provider in user-facing text only when the text is about that one reviewer;
otherwise call it the AI review.

Before pushing, run `npm ci`, `npm run lint`, and `npm run fmt:check`. oxlint
runs its correctness and pedantic rules as errors: fix a finding, split a long
file or function, and never disable a rule or raise a limit to pass.

The workflows load the action from a commit of this repository on `main`.
Change the action first, then pin the workflows to its commit in a later
change.
