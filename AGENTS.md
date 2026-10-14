# Agent Instructions

Follow the team's [workflow standards](https://github.com/Kong/volcano-conventions/blob/main/.agents/skills/team-workflow/SKILL.md).

This repository is meant to be public. Keep account IDs, internal hostnames,
credentials, and internal-only process out of it.

When changing `.github/actions/claude-review` or the Claude review workflows,
run `node --test .github/actions/claude-review/claude-review.test.cjs`. Every
Volcano repository's review runs this repository's `main`, so keep changes
compatible with callers' stubs and update `README.md` when the stub changes.

The workflows load the action from a commit of this repository on `main`.
Change the action first, then pin the workflows to its commit in a later
change.
