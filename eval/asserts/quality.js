// Structural quality gate, computed with the SAME validation code the
// extension ships: JSON parses, quotes are verbatim, enough evidence anchors.
const core = require("../../extension/core/verify.js");

module.exports = (output, { vars }) => {
  let parsed;
  try {
    parsed = core.parseAnalysis(output);
  } catch (e) {
    return { pass: false, score: 0, reason: "JSON parse failed: " + e.message };
  }
  const rawCount = (parsed.evidence || []).length;
  const excerpt = core.relevantExcerpt(vars.source, vars.claim);
  const valid = core.validateEvidence(parsed.evidence, excerpt);
  const verbatimRate = rawCount ? valid.length / rawCount : 0;
  const minEvidence = vars.min_evidence ?? 2;
  const pass = valid.length >= minEvidence && verbatimRate >= 0.6 && parsed.reasoning.length > 0;
  return {
    pass,
    score: verbatimRate,
    reason: `evidence ${valid.length}/${rawCount} verbatim-anchored (need >=${minEvidence}, rate >=60%)`,
  };
};
