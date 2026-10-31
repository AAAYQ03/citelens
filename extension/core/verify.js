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
      " ],\n" +
      ' "spans": [\n' +
      '  { "text": "EXACT verbatim substring of the CLAIM (the spans together should cover the whole claim, no overlaps)",\n' +
      '    "type": "quote" (verbatim from source) | "paraphrase" (faithful rewording) | "number" (restates a figure) | "causal_upgrade" (correlation stated as causation, hedge dropped) | "condition_dropped" (a qualifier/population/setting in the source is omitted) | "scope_broadened" (some/most -> all, narrower -> broader) | "time_shift" (different time frame than the source) | "entity_shift" (different subject than the source) | "contradicted" (source states the opposite) | "unsupported" (nothing in the source covers this),\n' +
      '    "note": "one short sentence in the CLAIM language: what transformation happened here",\n' +
      '    "evidence_quote": "EXACT verbatim substring of the EXCERPT this span derives from, or \"\" when type is unsupported" }\n' +
      " ]\n" +
      "}\n" +
      "Span rules: segment the ENTIRE claim into 1-8 non-overlapping spans copied character-for-character " +
      "from the CLAIM. The transformation type is about what changed between the source and the claim — " +
      "be strict: a dropped qualifier or an upgraded hedge is NOT a paraphrase.\n" +
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
    return {
      stance: STANCES.includes(parsed.stance) ? parsed.stance : null,
      reasoning: String(parsed.reasoning ?? ""),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      spans: Array.isArray(parsed.spans) ? parsed.spans : [],
    };
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

  // Claim-side spans: verbatim-or-drop against the CLAIM (mirror of the
  // evidence rule), enum-checked types, overlap-free, source quotes verified.
  function validateSpans(spans, claim, excerpt) {
    const nc = normWs(claim);
    const nx = normWs(excerpt);
    const out = [];
    for (const s of spans || []) {
      if (!s?.text || !SPAN_TYPES[s.type]) continue;
      const t = normWs(s.text);
      if (!t || t.length > 400) continue;
      const pos = nc.indexOf(t);
      if (pos < 0) continue;
      if (out.some((o) => pos < o.pos + o.text.length && o.pos < pos + t.length)) continue;
      let eq = normWs(s.evidence_quote || "");
      if (eq && !nx.includes(eq)) eq = "";
      out.push({ text: t, pos, type: s.type, note: String(s.note ?? "").slice(0, 200), evidence_quote: eq });
    }
    out.sort((a, b) => a.pos - b.pos);
    return out.slice(0, 8);
  }

  const extractNumbers = (s) =>
    (String(s).match(/\d+(?:[.,]\d+)?%?/g) || []).map((x) => x.replace(/,/g, ""));

  // The verdict is no longer a model opinion: it is a deterministic
  // aggregation over labeled transformations (plus a code-level numeric
  // consistency check). Returns null when there are no spans to aggregate.
  function deriveStance(spans) {
    if (!spans || !spans.length) return null;
    let overst = false;
    let contra = false;
    let unsupportedChars = 0;
    let totalChars = 0;
    for (const sp of spans) {
      totalChars += sp.text.length;
      const meta = SPAN_TYPES[sp.type];
      if (meta?.flag === "contradicted") contra = true;
      if (meta?.flag === "overstated") overst = true;
      if (meta?.flag === "unsupported") unsupportedChars += sp.text.length;
      if (sp.type === "number" && sp.evidence_quote) {
        const a = extractNumbers(sp.text);
        const b = extractNumbers(sp.evidence_quote);
        if (a.length && b.length && !a.every((n) => b.includes(n))) contra = true;
      }
    }
    if (contra) return "contradicted";
    if (overst) return "overstated";
    if (totalChars > 0 && unsupportedChars / totalChars > 0.6) return "not_addressed";
    return "supported";
  }

  // One entry point for both engines: validate everything, derive the stance
  // from spans when present, otherwise keep a model-provided stance.
  function finalizeAnalysis(parsed, claim, excerpt) {
    parsed.evidence = validateEvidence(parsed.evidence, excerpt);
    parsed.spans = validateSpans(parsed.spans, claim, excerpt);
    parsed.stance = deriveStance(parsed.spans) ?? parsed.stance ?? null;
    return parsed;
  }

  // Share of evidence quotes that anchor verbatim in the given text.
  function anchorRate(evidence, text) {
    const nx = normWs(text);
    const list = evidence || [];
    if (!list.length) return 0;
    const hit = list.filter((e) => e?.quote && nx.includes(normWs(e.quote))).length;
    return hit / list.length;
  }

  // JSON Schema for structured outputs on the prompt engine
  // (output_config.format; every object needs additionalProperties:false).
  const STANCES = ["supported", "overstated", "contradicted", "not_addressed"];

  // Transformation vocabulary (FRANK-lineage): what happened between the
  // source's words and the AI's sentence. Verbs, not nouns — this is where
  // "how the source leads to the claim" actually lives.
  const SPAN_TYPES = {
    quote: { zh: "直接引用", color: "#10b981", flag: null },
    paraphrase: { zh: "改述", color: "#64748b", flag: null },
    number: { zh: "数字复述", color: "#0ea5e9", flag: null }, // deterministically checked
    causal_upgrade: { zh: "因果升级", color: "#f43f5e", flag: "overstated" },
    condition_dropped: { zh: "条件省略", color: "#f59e0b", flag: "overstated" },
    scope_broadened: { zh: "范围扩大", color: "#f97316", flag: "overstated" },
    time_shift: { zh: "时间错位", color: "#a855f7", flag: "overstated" },
    entity_shift: { zh: "主体错位", color: "#d946ef", flag: "overstated" },
    contradicted: { zh: "与来源相反", color: "#dc2626", flag: "contradicted" },
    unsupported: { zh: "来源外补充", color: "#9ca3af", flag: "unsupported" },
  };

  const ANALYSIS_SCHEMA = {
    type: "object",
    properties: {
      reasoning: { type: "string" },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            quote: { type: "string" },
            label: { type: "string" },
            note: { type: "string" },
          },
          required: ["quote", "label", "note"],
          additionalProperties: false,
        },
      },
      spans: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            type: {
              type: "string",
              enum: ["quote", "paraphrase", "number", "causal_upgrade", "condition_dropped", "scope_broadened", "time_shift", "entity_shift", "contradicted", "unsupported"],
            },
            note: { type: "string" },
            evidence_quote: { type: "string" },
          },
          required: ["text", "type", "note", "evidence_quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["reasoning", "evidence", "spans"],
    additionalProperties: false,
  };

  // Split flat text into paragraph-ish blocks (fallback when the live page
  // can't provide DOM blocks, and for the eval harness).
  function splitIntoBlocks(text) {
    const paras = String(text ?? "").split(/\n{2,}/).map(normWs).filter(Boolean);
    const out = [];
    for (const p of paras) {
      if (p.length <= 700) {
        out.push(p);
        continue;
      }
      const sentences = p.split(/(?<=[。！？；])\s*|(?<=[.!?;])\s+/u);
      let cur = "";
      for (const s of sentences) {
        if ((cur + " " + s).trim().length > 700 && cur) {
          out.push(cur.trim());
          cur = s;
        } else {
          cur = (cur + " " + s).trim();
        }
      }
      if (cur) out.push(cur.trim());
    }
    return out;
  }

  // BM25-lite: keep the blocks most relevant to the claim within a char
  // budget, preserving document order. Returns the chosen texts plus a map
  // back to original block indices.
  function selectBlocks(blocks, claim, budget = 10000) {
    const claimTokens = tokenize(claim);
    const scored = (blocks || [])
      .map((text, i) => ({ text: normWs(text), i, sc: score(claimTokens, tokenize(text)) }))
      .filter((b) => b.text.length > 0);
    const byScore = [...scored].sort((a, b) => b.sc - a.sc);
    // Zero-relevance blocks (nav junk, unrelated sections) only qualify when
    // nothing matches the claim at all.
    const relevant = byScore.filter((b) => b.sc > 0);
    const pool = relevant.length ? relevant : byScore;
    const chosen = new Set();
    let used = 0;
    for (const b of pool) {
      if (used + b.text.length > budget) {
        if (chosen.size >= 3) break;
        continue;
      }
      chosen.add(b.i);
      used += b.text.length;
    }
    const picked = scored.filter((b) => chosen.has(b.i));
    return { texts: picked.map((b) => b.text), indexMap: picked.map((b) => b.i) };
  }

  // Explode selected paragraph blocks into sentence-level content blocks so
  // citation pointers come back sentence-grained (custom-content citations
  // cite whole provided blocks — paragraph blocks would mean paragraph
  // highlights). indexMap keeps each sentence's original page-block index.
  function explodeToSentences(texts, indexMap, maxLen = 250) {
    const outT = [];
    const outM = [];
    (texts || []).forEach((t, k) => {
      const parent = indexMap ? indexMap[k] : k;
      const sentences = String(t)
        .split(/(?<=[。！？；])\s*|(?<=[.!?;])\s+/u)
        .flatMap((s) => {
          s = s.trim();
          if (!s) return [];
          if (s.length <= maxLen) return [s];
          const parts = [];
          for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
          return parts;
        });
      for (const s of sentences) {
        outT.push(s);
        outM.push(parent);
      }
    });
    return { texts: outT, indexMap: outM };
  }

  // Prompt for the citations engine: evidence anchoring comes from the API's
  // citation pointers, the model only writes labels, notes and reasoning.
  function buildCitationsPrompt(claim) {
    return (
      "You are a citation-verification assistant. The attached document is the source that an " +
      "AI chat answer cites for the CLAIM below. Analyze how (and whether) the source supports the claim.\n\n" +
      "Write your answer as plain lines in EXACTLY this format (no markdown):\n" +
      "EVIDENCE: <label> | <one short sentence: why this passage matters for the claim>\n" +
      "  - 2 to 5 EVIDENCE lines. Every EVIDENCE line MUST carry at least one citation to the exact " +
      "sentence it refers to — an EVIDENCE line without a citation is invalid and will be discarded. " +
      "Cite single sentences, not whole paragraphs.\n" +
      "  - <label> is a 2-4 character category in the language of the CLAIM (e.g. 原理/推导/结论/数据/示例/条件/背景/观点, " +
      "or Principle/Data/Conclusion for English claims); pick what fits this article's genre\n" +
      "REASONING: <2-3 sentences in the language of the CLAIM explaining the logical chain from source to claim; " +
      "if the source does not actually support the claim, say so plainly and state what it actually says>\n" +
      "STANCE: <exactly one of: supported | overstated | contradicted | not_addressed>\n\n" +
      "CLAIM:\n" + claim
    );
  }

  // Turn a citations-enabled response (content blocks with citation arrays)
  // into the shared {reasoning, evidence[]} shape. indexMap maps the
  // document's block indices back to original page block indices (optional).
  function parseCitationsResponse(content, indexMap, blockTexts) {
    const evidence = [];
    const reasoningParts = [];
    let stance = null;
    for (const block of content || []) {
      if (block.type !== "text") continue;
      const text = String(block.text || "");
      const cits = block.citations || [];
      if (cits.length) {
        const m = text.match(/EVIDENCE:\s*([^|\n]{1,12})\|\s*([^\n]*)/);
        const label = normWs(m ? m[1] : "").slice(0, 6) || "证据";
        const note = normWs(m ? m[2] : text).slice(0, 200);
        for (const c of cits) {
          if (!c.cited_text) continue;
          const start = c.start_block_index ?? null;
          const end = c.end_block_index ?? (start != null ? start + 1 : null);
          if (blockTexts && start != null && end - start > 1) {
            // A citation spanning several sentence blocks becomes one
            // evidence item per block, so each quote stays sentence-sized.
            for (let bi = start; bi < end && bi < blockTexts.length; bi++) {
              evidence.push({
                quote: String(blockTexts[bi]),
                label,
                note,
                blockIndex: indexMap ? indexMap[bi] : bi,
              });
            }
            continue;
          }
          evidence.push({
            quote: String(c.cited_text),
            label,
            note,
            blockIndex: indexMap && start != null ? indexMap[start] : start,
          });
        }
      }
      const rm = text.match(/REASONING:\s*([\s\S]*?)(?=STANCE:|$)/);
      if (rm) reasoningParts.push(normWs(rm[1]));
      const sm = text.match(/STANCE:\s*(supported|overstated|contradicted|not_addressed)/);
      if (sm) stance = sm[1];
    }
    return { stance, reasoning: reasoningParts.join(" ").trim(), evidence };
  }

  // Whole-answer overview: decompose an answer into atomic, verifiable
  // claims, each mapped to the citation URL (if any) that backs it.
  const DECOMPOSE_SCHEMA = {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            url: { type: "string" },
            verifiable: { type: "boolean" },
          },
          required: ["text", "url", "verifiable"],
          additionalProperties: false,
        },
      },
    },
    required: ["claims"],
    additionalProperties: false,
  };

  function buildDecomposePrompt(answerText, citationUrls) {
    return (
      "Decompose this AI chat answer into its ATOMIC, VERIFIABLE factual claims " +
      "(VeriScore-style: drop subjective framing, advice, and meta-commentary; keep checkable " +
      "assertions about the world). For each claim, copy its text in the answer's language, " +
      "set url to the citation URL from the list below that the answer attaches to this claim " +
      '(or "" if the claim carries no citation), and verifiable=true unless the claim is opinion.\n' +
      "Return at most 8 claims, in the order they appear.\n\n" +
      "CITATION URLS IN THIS ANSWER:\n" + (citationUrls || []).map((u) => "- " + u).join("\n") +
      "\n\nANSWER:\n" + String(answerText).slice(0, 8000)
    );
  }

  function validateClaims(claims, citationUrls) {
    const allowed = new Set(citationUrls || []);
    return (claims || [])
      .filter((c) => c && normWs(c.text).length > 15)
      .map((c) => ({
        text: normWs(c.text).slice(0, 500),
        url: allowed.has(c.url) ? c.url : "",
        verifiable: c.verifiable !== false,
      }))
      .slice(0, 8);
  }

  return { normWs, tokenize, score, relevantExcerpt, buildPrompt, parseAnalysis, validateEvidence, anchorRate, ANALYSIS_SCHEMA, STANCES, SPAN_TYPES, validateSpans, deriveStance, finalizeAnalysis, splitIntoBlocks, selectBlocks, explodeToSentences, buildCitationsPrompt, parseCitationsResponse, DECOMPOSE_SCHEMA, buildDecomposePrompt, validateClaims };
});
