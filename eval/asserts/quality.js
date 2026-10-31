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
  // Stance agreement: hard gate on exception cases (the whole point of the
  // flag), reported-only on supported ones (borderline overstated calls are
  // judged by the llm-rubric asserts instead).
  const stanceKnown = !!vars.stance && !!parsed.stance;
  const stanceAgrees = stanceKnown ? parsed.stance === vars.stance : null;
  const stanceGate = vars.stance && vars.stance !== "supported" ? stanceAgrees === true : true;
  const pass = valid.length >= minEvidence && verbatimRate >= 0.6 && parsed.reasoning.length > 0 && stanceGate;
  return {
    pass,
    score: verbatimRate,
    reason:
      `evidence ${valid.length}/${rawCount} verbatim-anchored (need >=${minEvidence}, rate >=60%)` +
      (stanceKnown ? `; stance ${parsed.stance} vs human ${vars.stance} (${stanceAgrees ? "agree" : "DISAGREE"})` : ""),
  };
};
