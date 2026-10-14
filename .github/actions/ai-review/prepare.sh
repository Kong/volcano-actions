#!/usr/bin/env bash
# Writes a reviewer's inputs to $INPUTS from the base checkout at the workspace
# root. The PR head is only data there, in a separate worktree, never executed.
# action.yml runs this for `step: prepare` and passes REPO, PR_NUMBER,
# BASE_SHA, HEAD_SHA, INPUTS, and GH_TOKEN through env.
set -euo pipefail
mkdir -p "$INPUTS"
# The head is not on a fetched branch once the PR has moved past it.
git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || git fetch --no-tags --quiet origin "$HEAD_SHA"
# The base's .gitattributes apply, so the PR cannot mark its own
# changes binary; real binaries stay out of the diff as summaries.
git diff --no-ext-diff --no-textconv "$BASE_SHA...$HEAD_SHA" > "$INPUTS/pr.diff"
# Git also calls a file binary for a NUL or invalid byte, which
# JavaScript and shell still run. Append each such change of at most
# 64 KiB a side as text, dropping bytes that are not UTF-8; larger
# ones stay summaries, which the policy treats as hidden content.
merge_base=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
git diff --numstat -z --no-renames "$BASE_SHA...$HEAD_SHA" | while IFS= read -r -d '' line; do
  [[ $line == $'-\t-\t'* ]] || continue
  file=${line#$'-\t-\t'}
  small=true
  for rev in "$merge_base" "$HEAD_SHA"; do
    if git cat-file -e "$rev:$file" 2>/dev/null && [ "$(git cat-file -s "$rev:$file")" -gt 65536 ]; then
      small=false
    fi
  done
  if $small; then
    { git --literal-pathspecs diff --text --no-ext-diff --no-textconv --no-renames "$BASE_SHA...$HEAD_SHA" -- "$file" |
      iconv -c -f UTF-8 -t UTF-8 || true; } >> "$INPUTS/pr.diff"
  fi
done
git log --format='%h %s%n%n%b' "$BASE_SHA..$HEAD_SHA" > "$INPUTS/commits.txt"
gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '"# " + .title + "\n\n" + (.body // "")' > "$INPUTS/description.md"
gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate \
  --jq '.[] | {path, line, author: .user.login, body}' > "$INPUTS/review-comments.jsonl"

# A reviewer can discover instructions, skills, and MCP servers in a
# directory it reads, so the head checkout drops them; the PR's
# changes to them stay visible in pr.diff.
git worktree add --quiet --detach "$INPUTS/head" "$HEAD_SHA"
pattern='(^|/)((AGENTS|CLAUDE)(\.local)?\.md|\.mcp\.json|\.claude(/.*)?)$'
git -C "$INPUTS/head" ls-files -z | { grep -zE "$pattern" || [ $? -eq 1 ]; } |
  (cd "$INPUTS/head" && xargs -0 -r rm -rf --)

# Reviewers load at most the base's root instructions on their own: not
# the scoped files that govern head paths, and not AGENTS.md beside a
# CLAUDE.md. List the base's files for each changed path's
# directories; the policy has reviewers read them.
git diff --name-only -z --no-renames "$BASE_SHA...$HEAD_SHA" | while IFS= read -r -d '' file; do
  dir=$(dirname "$file")
  while :; do
    for name in AGENTS.md CLAUDE.md; do
      if [ "$dir" = . ]; then path=$name; else path=$dir/$name; fi
      if [ -f "$path" ]; then printf '%s\n' "$path"; fi
    done
    [ "$dir" != . ] || break
    dir=$(dirname "$dir")
  done
done | sort -u > "$INPUTS/instructions.txt"
