'use strict';

// Runs in actions/github-script from a pinned trusted revision, never from the PR,
// so a PR cannot change how its review is judged. See action.yml.
const { statusContext, humanStatusContext, overrideLabel, humanLabel, marker, severities } = require('./constants.cjs');
const { verdict } = require('./verdict.cjs');
const { globRegExp } = require('./paths.cjs');
const { start, publish, override, gate } = require('./steps.cjs');
const { candidates } = require('./candidates.cjs');

module.exports = {
  statusContext,
  humanStatusContext,
  overrideLabel,
  humanLabel,
  marker,
  severities,
  verdict,
  globRegExp,
  start,
  publish,
  override,
  gate,
  candidates,
};
