'use strict';

const { storedDecision } = require('./decision.cjs');
const { summaryComment } = require('./github.cjs');

// A deferred P2 passes `ai-review/verdict` once the summary records the
// deferral and `ai-review/human` has been set from it (see publish). The human
// status, not the verdict, waits for a person: it needs an approval of the
// reviewed commit given after `since`, in the summary's marker, which is when
// GitHub recorded the summary that first reported the deferral (see
// human.cjs). An approval given before then cannot have decided it.

// Whether every deferred problem, given by its key (see problems.cjs), is one
// of the stored ones, counting repeats.
function covered(deferred, stored) {
  const left = [...stored];
  for (const key of deferred) {
    const i = left.indexOf(key);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

// The time a re-run of this commit keeps: the stored one, when it defers
// nothing the last review of this commit did not. Otherwise, or when the
// summary cannot be read, null: publish dates the deferral afresh.
async function keptSince(github, context, sha, deferred) {
  if (deferred.length === 0) return null;
  try {
    const stored = storedDecision(await summaryComment(github, context, context.payload.pull_request.number), sha);
    return stored?.since && covered(deferred, stored.deferred) ? stored.since : null;
  } catch {
    return null;
  }
}

// The cutoff a later event applies: the stored time, or, for a deferral the
// summary has not dated yet, now, so no approval counts until it is.
const cutoff = (stored) => stored?.since ?? (stored?.deferred.length > 0 ? new Date().toISOString() : null);

module.exports = { keptSince, cutoff };
