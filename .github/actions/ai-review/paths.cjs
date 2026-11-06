'use strict';

// Matches a repository-relative path against a glob: `*` and `?` stay within
// one directory, `**/` spans any number of them, and a final `**` matches the rest.
function globRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      pattern += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      pattern += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      pattern += '[^/]*';
    } else if (glob[i] === '?') {
      pattern += '[^/]';
    } else {
      pattern += glob[i].replaceAll(/[\\^$.|+(){}[\]]/gu, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`, 'u');
}

// The globs a repository reserves for a person, one per line, each optionally
// followed by `except` and the logins, comma-separated, whose own PRs it does
// not reserve, such as the owner of a directory.
function reservedPaths() {
  return (process.env.HUMAN_REVIEW_PATHS || '')
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'))
    .map((line) => {
      const [glob, ...rest] = line.split(/\s+except\s+/u);
      const except = rest
        .join(',')
        .split(',')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean);
      return { glob: glob.trim(), except };
    });
}

// Reasons from the paths a repository reserves for a person, which no PR text
// can argue away. Every other change is the reviewers' call. A rename counts
// at both its old and new path. GitHub lists at most 3000 files, so a larger
// PR cannot be checked in full. `author` is the PR author's login.
async function pathReasons(github, context, number, author = '') {
  const own = reservedPaths().filter((p) => !p.except.includes(author.toLowerCase()));
  if (own.length === 0) return [];
  let files;
  try {
    files = await github.paginate(github.rest.pulls.listFiles, { ...context.repo, pull_number: number, per_page: 100 });
  } catch {
    return ['Could not list the changed files to check them for paths that need a human review.'];
  }
  if (files.length >= 3000) return ['Changes more files than GitHub lists, so not every path could be checked.'];
  const changed = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean))];
  const reserved = changed.filter((file) => own.some((p) => globRegExp(p.glob).test(file)));
  if (reserved.length === 0) return [];
  const more = reserved.length > 1 ? ` (+${reserved.length - 1} more)` : '';
  return [`Changes a path this repository reserves for human review: ${reserved[0]}${more}.`];
}

// A repository can have a person review every PR a bot opens, whatever the
// reviews decide, by setting HUMAN_REVIEW_BOTS to `true`.
const authorReasons = (user) =>
  process.env.HUMAN_REVIEW_BOTS === 'true' && user?.type === 'Bot'
    ? [`Opened by ${user.login}, and this repository has a person review every bot's PR.`]
    : [];

module.exports = { globRegExp, pathReasons, authorReasons };
