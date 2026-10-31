// Custom promptfoo provider that calls the Anthropic API exactly the way the
// extension does, for both engines:
//   engine: "prompt"    — buildPrompt + structured outputs (JSON schema)
//   engine: "citations" — custom-content document + citation pointers
// Output is normalized to the shared {reasoning, evidence[]} JSON so
// asserts/quality.js applies unchanged across the whole matrix.
const core = require("../../extension/core/verify.js");

const API = "https://api.anthropic.com/v1/messages";

class EngineProvider {
  constructor(options = {}) {
    this.cfg = options.config || {};
    this.label = options.label || `${this.cfg.engine || "prompt"}:${this.cfg.model}`;
  }

  id() {
    return this.label;
  }

  async callApi(_prompt, context) {
    const { claim, source } = context.vars;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { error: "ANTHROPIC_API_KEY not set" };
    const model = this.cfg.model;
    const engine = this.cfg.engine || "prompt";

    let body;
    if (engine === "citations") {
      const picked = core.selectBlocks(core.splitIntoBlocks(source), claim);
      const sel = core.explodeToSentences(picked.texts, picked.indexMap);
      body = {
        model,
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "content", content: sel.texts.map((t) => ({ type: "text", text: t })) },
              title: "Source",
              citations: { enabled: true },
            },
            { type: "text", text: core.buildCitationsPrompt(claim) },
          ],
        }],
      };
    } else {
      const excerpt = core.relevantExcerpt(source, claim);
      body = {
        model,
        max_tokens: 4000,
        output_config: { format: { type: "json_schema", schema: core.ANALYSIS_SCHEMA } },
        messages: [{ role: "user", content: core.buildPrompt(claim, excerpt) }],
      };
    }

    const res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { error: data?.error?.message || "HTTP " + res.status };

    const usage = {
      total: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      prompt: data.usage?.input_tokens || 0,
      completion: data.usage?.output_tokens || 0,
    };

    if (engine === "citations") {
      const parsed = core.parseCitationsResponse(data.content, null, body.messages[0].content[0].source.content.map((c) => c.text));
      return { output: JSON.stringify(parsed), tokenUsage: usage };
    }
    const raw = (data.content || []).find((b) => b.type === "text")?.text || "";
    try {
      return { output: JSON.stringify(core.parseAnalysis(raw)), tokenUsage: usage };
    } catch {
      // Surface the malformed output so the quality assert records the failure.
      return { output: raw, tokenUsage: usage };
    }
  }
}

module.exports = EngineProvider;
