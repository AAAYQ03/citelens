// CiteLens verification core — pure functions shared by the extension panel
// (window.CiteLensCore) and the eval harness / unit tests (require()).
// Keep this file free of DOM and chrome.* so it stays testable in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CiteLensCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  const normWs = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  function tokenize(s) {
    return new Set(
      String(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2)
    );
  }

  // Containment score: how much of the smaller token set is inside the other.
  function score(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / Math.min(a.size, b.size);
  }

  // Pick the part of the source most relevant to the claim (<= ~12k chars).
  function relevantExcerpt(text, claim) {
    text = String(text ?? "");
    if (text.length <= 12000) return text;
    const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/u).filter((s) => s.trim().length > 0);
    const claimTokens = tokenize(claim);
    let best = null;
    for (const s of sentences) {
      const sc = score(claimTokens, tokenize(s));
      if (!best || sc > best.sc) best = { s, sc };
    }
    if (best && best.sc >= 0.25) {
      const i = text.indexOf(best.s);
      if (i >= 0) return text.slice(Math.max(0, i - 6000), i + best.s.length + 6000);
    }
    return text.slice(0, 12000);
  }

  function buildPrompt(claim, excerpt) {
    return (
      "You are a citation-verification assistant. Given a CLAIM from an AI chat answer and an " +
      "EXCERPT of the source it cites, analyze how (and whether) the source supports the claim.\n\n" +
      "Return ONLY valid JSON, no markdown fences:\n" +
      "{\n" +
      ' "reasoning": "2-3 sentences explaining the logical chain from source to claim. Write in the same language as the CLAIM.",\n' +
      ' "evidence": [\n' +
      '  { "quote": "EXACT verbatim substring copied character-for-character from the EXCERPT (keep its original language)",\n' +
      '    "label": "a 2-4 character category label in the language of the CLAIM, describing what KIND of content this passage is",\n' +
      '    "note": "one short sentence: why this passage matters for the claim, in the language of the CLAIM" }\n' +
      " ]\n" +
      "}\n" +
      "Label guidance: pick whatever fits THIS article's genre — common ones include " +
      "原理/推导/结论/数据/示例/条件/背景/观点 (or Principle/Reasoning/Conclusion/Data/Example/Condition for English claims), " +
      "but invent a better short label if none fit. Never force a category that does not match the text.\n" +
      "Rules: 2-5 evidence items, each anchored to a DIFFERENT passage (no overlapping quotes). " +
      "When the same idea appears in BOTH an intro/summary paragraph and a detailed section below, " +
      "quote the DETAILED section, not the summary. " +
      "Quotes MUST be exact substrings of the EXCERPT (validated programmatically; paraphrases are discarded). " +
      "Each quote must be ONE sentence or clause, at most ~40 words / 100 characters — never a whole paragraph. " +
      "If the source does not actually support the claim, say so plainly in the reasoning and cite what it actually says.\n\n" +
      "CLAIM:\n" + claim + "\n\nEXCERPT:\n" + excerpt
    );
  }

  // Strip optional markdown fences and parse the model's JSON.
  function parseAnalysis(raw) {
    const cleaned = String(raw ?? "")
      .replace(/^```(json)?/g, "")
      .replace(/```$/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return { reasoning: String(parsed.reasoning ?? ""), evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [] };
  }

  // Verbatim-or-drop, dedupe, cap, label hygiene, then sort by source position.
  function validateEvidence(evidence, excerpt) {
    const nx = normWs(excerpt);
    const seen = new Set();
    return (evidence || [])
      .filter((e) => {
        if (!e?.quote || normWs(e.quote).length > 300) return false;
        if (!nx.includes(normWs(e.quote))) return false;
        const k = normWs(e.quote);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((e) => ({
        quote: String(e.quote),
        label: normWs(e.label || "").slice(0, 6) || "证据",
        note: String(e.note ?? ""),
      }))
      .slice(0, 5)
      .sort((a, b) => nx.indexOf(normWs(a.quote)) - nx.indexOf(normWs(b.quote)));
  }

  // Share of evidence quotes that anchor verbatim in the given text.
  function anchorRate(evidence, text) {
    const nx = normWs(text);
    const list = evidence || [];
    if (!list.length) return 0;
    const hit = list.filter((e) => e?.quote && nx.includes(normWs(e.quote))).length;
    return hit / list.length;
  }

  return { normWs, tokenize, score, relevantExcerpt, buildPrompt, parseAnalysis, validateEvidence, anchorRate };
});
