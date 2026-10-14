# Agent Instructions

Follow the team's [workflow standards](https://github.com/Kong/volcano-conventions/blob/main/.agents/skills/team-workflow/SKILL.md).

This repository is meant to be public. Keep account IDs, internal hostnames,
credentials, and internal-only process out of it.

When changing `.github/actions/claude-review` or the Claude review workflows,
run `npm test`. Every Volcano repository's review runs this repository's
`main`, so keep changes compatible with callers' stubs and update `README.md`
when the stub changes.

Before pushing, run `npm ci`, `npm run lint`, and `npm run fmt:check`. oxlint
runs its correctness and pedantic rules as errors: fix a finding, split a long
file or function, and never disable a rule or raise a limit to pass.

The workflows load the action from a commit of this repository on `main`.
Change the action first, then pin the workflows to its commit in a later
change.
