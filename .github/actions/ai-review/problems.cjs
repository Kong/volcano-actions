'use strict';

// Groups the findings of several reviewers into problems, so the verdict lists
// and counts each problem once. Reviewers word and place one problem
// differently: two models often report it a few lines apart under different
// titles, or in different files under nearly the same title.

const { severities } = require('./constants.cjs');

const levels = Object.keys(severities);
// Findings from different reviewers at most this many lines apart in one file
// are one problem. In a sample of real reviews, 16 of 17 such pairs were.
const nearbyLines = 20;
// Titles whose words overlap at least this much (the Dice coefficient) are
// nearly the same. In the same sample, every pair at or above it was one
// problem, and pairs below 0.4 often were not.
const nearlySame = 0.5;

// Words that say nothing about which problem a title names.
const fillers = new Set(
  (
    'the and for not but with without from into onto that this its are was were has have had can may might when ' +
    'then than only all any each every one two before after instead same other there their them they which ' +
    'while what will would should could does did use uses used using still also just more most less new newly ' +
    'now never'
  ).split(' '),
);

// A title's words, lowercased and cut to five letters, so that `suppresses`
// matches `suppression` and `Deployments` matches `deployment`. camelCase and
// snake_case split into words.
const stems = (title) =>
  new Set(
    title
      .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length >= 3 && !fillers.has(word))
      .map((word) => word.replace(/(?<=..)s$/u, '').slice(0, 5)),
  );

const normalized = (title) =>
  title
    .toLowerCase()
    .replaceAll(/\s+/gu, ' ')
    .replace(/[\s.!]+$/u, '')
    .trim();

function similarTitles(a, b) {
  if (normalized(a) === normalized(b)) return true;
  const [x, y] = [stems(a), stems(b)];
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((word) => y.has(word)).length;
  return (2 * shared) / (x.size + y.size) >= nearlySame;
}

const nearby = (a, b) => a.path === b.path && a.line > 0 && b.line > 0 && Math.abs(a.line - b.line) <= nearbyLines;

const sameProblem = (a, b) => nearby(a, b) || similarTitles(a.title, b.title);

// Each problem's paths and lines, as the summary shows them: lines ascending
// within a path, and a path alone for a finding on the whole file.
function locations(group) {
  const paths = new Map();
  for (const { path, line } of group) {
    if (!paths.has(path)) paths.set(path, new Set());
    if (line > 0) paths.get(path).add(line);
  }
  return [...paths].map(([path, lines]) => ({ path, lines: [...lines].toSorted((a, b) => a - b) }));
}

// The problems in each reviewer's findings, given as one list per reviewer,
// most severe first. A finding joins the first problem with a finding from
// another reviewer at most nearbyLines away in the same file, or with nearly
// the same title, unless that problem already holds one of its own reviewer's:
// one reviewer's findings stay as distinct as it wrote them. A problem takes
// its most severe finding's level and title.
function problems(findingsByReviewer) {
  const all = findingsByReviewer.flatMap((findings, reviewer) => findings.map((f) => ({ ...f, reviewer })));
  const groups = [];
  for (const f of all.toSorted((a, b) => levels.indexOf(a.severity) - levels.indexOf(b.severity))) {
    const group = groups.find((g) => g.every((m) => m.reviewer !== f.reviewer) && g.some((m) => sameProblem(m, f)));
    if (group) group.push(f);
    else groups.push([f]);
  }
  return groups.map((group) => ({ severity: group[0].severity, title: group[0].title, at: locations(group) }));
}

module.exports = { problems, similarTitles };
