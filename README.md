# ◎ CiteLens

**See exactly where every AI claim comes from.**

AI chat products cite sources as little numbered links — but verifying a claim still means
opening a page and hunting for the passage yourself. CiteLens closes that gap: ask a question
against real sources, and read the answer in a **split view where every sentence is linked,
bidirectionally, to the exact passage it cites**.

## What it does

- **Grounded answers** — bring up to 3 sources (URLs are auto-extracted, or paste text) and ask
  a question. Answers are generated with the [Anthropic Citations API](https://platform.claude.com/docs/en/build-with-claude/citations),
  so every cited passage is *extracted from the source, not generated* — highlights can't hallucinate.
- **Claim-level verification badges** — sentences backed by a source are marked green;
  substantive sentences with **no source support get a ⚠ badge** automatically.
- **Bidirectional sync** — click a sentence on the left → the source panel scrolls to the exact
  passage and highlights it. Click a highlight on the right → jump back to every claim citing it.
- **Zero-setup demo** — a built-in example works with no API key, so anyone can feel the
  interaction in one click.

## Why (the product angle)

Existing tools split into two camps:

| Camp | Examples | Gap |
| --- | --- | --- |
| RAG "chat with your docs" | NotebookLM, Kotaemon, RAGFlow | Great in-doc citations, but one-directional and locked to their own chat |
| General AI chat with web cites | ChatGPT, Perplexity | Citations are links, not passages — verification is still manual |

CiteLens explores the middle: a lightweight **verification layer** for AI answers, built around
*time-to-verify* as the core metric. Roadmap: manual verified/contradicted marking + exportable
verification reports → PDF sources → multi-model "citation diff" (ask GPT/Claude/Gemini the same
question, compare whose claims survive checking).

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: add ANTHROPIC_API_KEY
npm run dev
```

No key? The **demo mode** works out of the box, and visitors can also bring their own key
(kept in localStorage, sent only with their own requests).

## Stack

Next.js (App Router) · Tailwind CSS · Anthropic Citations API · Mozilla Readability for URL
extraction. Deployed on Vercel.

## Chrome extension

`extension/` is a Manifest V3 Chrome extension (zero build step) that brings the verification
layer **natively onto chatgpt.com**:

1. A ◎ button appears next to every citation in a ChatGPT answer.
2. Clicking it opens the **original cited page** in Chrome's side panel — a per-URL
   `declarativeNetRequest` session rule strips anti-embedding headers so the real page renders
   with its full layout.
3. **Analyze** (one Haiku call, bring-your-own Anthropic key stored only in the browser) explains
   *why the source supports the claim*: a verdict (✅ supported / ⚠️ partial / ❌ not supported),
   a reasoning chain, and 2–5 verbatim evidence quotes with open-ended category labels
   (原理 / 推导 / 结论 / 数据 / 示例 / 条件 …, chosen to fit the article's genre).
4. Evidence is painted **into the live page**: sentence-precise colored highlights via the CSS
   Custom Highlight API (no DOM breakage), and a collapsible "why this passage matters" note
   under each annotated block. Chips in the panel jump straight to their passage.

Anti-hallucination: quotes are validated as exact substrings of the page text before anything
is rendered — an annotation can never point at text that isn't really there. Analysis runs on
the **rendered** page text (not fetched HTML), so locale variants and JS-rendered content
anchor correctly; the panel reports how many evidence items were located.

Install: `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.

Roadmap: whole-answer overview (verify every citation in one pass), select-any-text
verification, claude.ai adapter, exportable verification reports.
