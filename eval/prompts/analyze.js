// Single source of truth: the exact prompt the extension sends, built by the
// shared core (same excerpt windowing included).
const core = require("../../extension/core/verify.js");

module.exports = function ({ vars }) {
  return core.buildPrompt(vars.claim, core.relevantExcerpt(vars.source, vars.claim));
};
