import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../extension/core/verify.js");

test("normWs collapses whitespace", () => {
  assert.equal(core.normWs("  a\n\tb   c "), "a b c");
});

test("parseAnalysis strips markdown fences", () => {
  const out = core.parseAnalysis('```json\n{"reasoning":"r","evidence":[]}\n```');
  assert.equal(out.reasoning, "r");
  assert.deepEqual(out.evidence, []);
});

test("parseAnalysis throws on garbage", () => {
  assert.throws(() => core.parseAnalysis("not json at all"));
});

test("validateEvidence drops paraphrased (non-verbatim) quotes", () => {
  const excerpt = "The quick brown fox jumps over the lazy dog.";
  const out = core.validateEvidence(
    [
      { quote: "quick brown fox", label: "数据", note: "n" },
      { quote: "a fast auburn fox", label: "数据", note: "n" },
    ],
    excerpt
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].quote, "quick brown fox");
});

test("validateEvidence is whitespace-tolerant", () => {
  const excerpt = "Alpha  beta\n gamma delta.";
  const out = core.validateEvidence([{ quote: "beta gamma", label: "x", note: "" }], excerpt);
  assert.equal(out.length, 1);
});

test("validateEvidence dedupes and caps at 5", () => {
  const excerpt = "one two three four five six seven eight nine ten";
  const ev = ["one", "one", "two", "three", "four", "five", "six"].map((q) => ({
    quote: q, label: "l", note: "",
  }));
  const out = core.validateEvidence(ev, excerpt);
  assert.equal(out.length, 5);
  assert.equal(new Set(out.map((e) => e.quote)).size, 5);
});

test("validateEvidence drops quotes over 300 chars", () => {
  const long = "x".repeat(301);
  const out = core.validateEvidence([{ quote: long, label: "l", note: "" }], long);
  assert.equal(out.length, 0);
});

test("validateEvidence sorts by position in the source", () => {
  const excerpt = "first part here. middle part here. last part here.";
  const out = core.validateEvidence(
    [
      { quote: "last part", label: "a", note: "" },
      { quote: "first part", label: "b", note: "" },
      { quote: "middle part", label: "c", note: "" },
    ],
    excerpt
  );
  assert.deepEqual(out.map((e) => e.quote), ["first part", "middle part", "last part"]);
});

test("validateEvidence normalizes labels (default + truncation)", () => {
  const excerpt = "some source text";
  const out = core.validateEvidence(
    [
      { quote: "source text", label: "", note: "" },
      { quote: "some source", label: "原理推导结论数据示例", note: "" },
    ],
    excerpt
  );
  assert.equal(out.find((e) => e.quote === "source text").label, "证据");
  assert.equal(out.find((e) => e.quote === "some source").label.length, 6);
});

test("relevantExcerpt passes short text through", () => {
  assert.equal(core.relevantExcerpt("short text", "claim"), "short text");
});

test("relevantExcerpt windows around the best-matching sentence", () => {
  const filler = "irrelevant filler sentence. ".repeat(600); // ~16k chars
  const needle = "Solar panel efficiency improved dramatically this decade.";
  const text = filler + needle + " " + filler;
  const out = core.relevantExcerpt(text, "How much did solar panel efficiency improve?");
  assert.ok(out.length <= 13000);
  assert.ok(out.includes(needle));
});

test("anchorRate computes located fraction", () => {
  const text = "alpha beta gamma";
  const ev = [
    { quote: "alpha beta" },
    { quote: "delta epsilon" },
  ];
  assert.equal(core.anchorRate(ev, text), 0.5);
});

test("buildPrompt embeds claim and excerpt verbatim", () => {
  const p = core.buildPrompt("MY CLAIM", "MY EXCERPT");
  assert.ok(p.includes("CLAIM:\nMY CLAIM"));
  assert.ok(p.includes("EXCERPT:\nMY EXCERPT"));
});
