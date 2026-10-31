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
  // Stance is DERIVED: deterministic aggregation over validated claim spans
  // (transformation labels + numeric check); a model-provided stance only
  // backstops span-less engines. Hard gate on exception cases.
  const spans = core.validateSpans(parsed.spans, vars.claim, excerpt);
  const spanCoverage = spans.reduce((s, sp) => s + sp.text.length, 0) /
    Math.max(1, core.normWs(vars.claim).length);
  const derived = core.deriveStance(spans) ?? parsed.stance ?? null;
  const stanceKnown = !!vars.stance && !!derived;
  const stanceAgrees = stanceKnown ? derived === vars.stance : null;
  const stanceGate = vars.stance && vars.stance !== "supported" ? stanceAgrees === true : true;
  const pass = valid.length >= minEvidence && verbatimRate >= 0.6 && parsed.reasoning.length > 0 && stanceGate;
  return {
    pass,
    score: verbatimRate,
    reason:
      `evidence ${valid.length}/${rawCount} verbatim-anchored (need >=${minEvidence}, rate >=60%)` +
      (stanceKnown ? `; derived stance ${derived} vs human ${vars.stance} (${stanceAgrees ? "agree" : "DISAGREE"})` : "") +
      `; spans ${spans.length}, coverage ${(spanCoverage * 100).toFixed(0)}%`,
  };
};
