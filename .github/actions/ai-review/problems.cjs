'use strict';

// Groups the findings of several reviewers into problems, so the verdict lists
// and counts each problem once, and each gets one inline comment. Reviewers
// word and place one problem differently: two models often report it a few
// lines apart under different titles, or in different files under nearly the
// same title.

const { severities, failing } = require('./constants.cjs');

const levels = Object.keys(severities);
// Findings from different reviewers at most this many lines apart in one file
// are one problem. In a sample of real reviews, 16 of 17 such pairs were.
const nearbyLines = 20;
// Titles whose words overlap at least this much (the Dice coefficient), in at
// least sharedWords words, are nearly the same. In the same sample, every pair
// at or above it was one problem, and pairs below 0.4 often were not. Short
// titles that share one or two words, such as "SQL injection" and "Command
// injection", can name different problems.
const nearlySame = 0.5;
const sharedWords = 3;

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

// The share of two titles' words they have in common, and how many.
function overlap(a, b) {
  const [x, y] = [stems(a), stems(b)];
  const shared = [...x].filter((word) => y.has(word)).length;
  return { shared, dice: x.size + y.size > 0 ? (2 * shared) / (x.size + y.size) : 0 };
}

function similarTitles(a, b) {
  if (normalized(a) === normalized(b)) return true;
  const { shared, dice } = overlap(a, b);
  return shared >= sharedWords && dice >= nearlySame;
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

// How well a finding fits a problem: by title first, then by distance.
function fit(group, f) {
  const lines = group.filter((m) => nearby(m, f)).map((m) => Math.abs(m.line - f.line));
  return {
    title: Math.max(
      ...group.map((m) => (normalized(m.title) === normalized(f.title) ? 1 : overlap(m.title, f.title).dice)),
    ),
    distance: Math.min(Infinity, ...lines),
  };
}
const better = (a, b) => a.title > b.title || (a.title === b.title && a.distance < b.distance);

// The problem a finding joins: of those it matches that hold no finding from
// its reviewer, the one it fits best.
function bestFor(groups, f) {
  let best = null;
  for (const group of groups) {
    if (group.some((m) => m.reviewer === f.reviewer) || !group.some((m) => sameProblem(m, f))) continue;
    const score = fit(group, f);
    if (!best || better(score, best.score)) best = { group, score };
  }
  return best?.group;
}

// A problem is deferred when each of its P0-P2 findings is a P2 the author
// deferred (see policy.md); no other level can be.
function deferred(group) {
  const blocking = group.filter((m) => failing.has(m.severity));
  return blocking.length > 0 && blocking.every((m) => m.severity === 'p2' && m.deferred === true);
}

// A problem as the summary shows it: its most severe finding's level and title,
// the other reviewers' titles that say something else, so a wrong merge hides
// nothing, every location, and whether it is deferred.
function shown(group) {
  const titles = [group[0].title];
  for (const { title } of group.slice(1)) if (!titles.some((t) => similarTitles(t, title))) titles.push(title);
  return {
    severity: group[0].severity,
    title: titles[0],
    also: titles.slice(1),
    at: locations(group),
    deferred: deferred(group),
  };
}

// The problems in each reviewer's findings, given as one list per reviewer:
// each the findings it holds, most severe first, with `reviewer` set to their
// reviewer's index, in order of their most severe. A finding joins a problem
// with a finding from another reviewer at most nearbyLines away in the same
// file, or with nearly the same title, unless that problem already holds one
// of its own reviewer's: one reviewer's findings stay as distinct as it wrote
// them.
function grouped(findingsByReviewer) {
  const all = findingsByReviewer.flatMap((findings, reviewer) => findings.map((f) => ({ ...f, reviewer })));
  const groups = [];
  for (const f of all.toSorted((a, b) => levels.indexOf(a.severity) - levels.indexOf(b.severity))) {
    const group = bestFor(groups, f);
    if (group) group.push(f);
    else groups.push([f]);
  }
  return groups;
}

// The problems as the summary shows them, in the same order.
const problems = (findingsByReviewer) => grouped(findingsByReviewer).map((group) => shown(group));

module.exports = { problems, grouped, deferred, similarTitles };
