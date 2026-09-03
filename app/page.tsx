"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnswerBlock, AnswerResult, SourceDoc } from "@/lib/types";
import { DEMO } from "@/lib/demo";

type SourceInput = {
  mode: "url" | "text";
  url: string;
  title: string;
  content: string;
};

const emptySource = (): SourceInput => ({ mode: "url", url: "", title: "", content: "" });

type Range = { start: number; end: number; blocks: number[] };

function computeRanges(docContent: string, blocks: AnswerBlock[], docIndex: number): Range[] {
  const ranges: Range[] = [];
  blocks.forEach((b, bi) => {
    b.citations.forEach((c) => {
      if (c.docIndex !== docIndex) return;
      const needle = c.citedText.trim();
      let start = docContent.indexOf(needle);
      let end = start + needle.length;
      if (start < 0) {
        // fallback: anchor on the first 40 chars (whitespace differences etc.)
        start = docContent.indexOf(needle.slice(0, 40));
        if (start < 0) return;
        end = Math.min(start + needle.length, docContent.length);
      }
      ranges.push({ start, end, blocks: [bi] });
    });
  });
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.blocks = [...new Set([...last.blocks, ...r.blocks])];
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export default function Home() {
  const [stage, setStage] = useState<"input" | "result">("input");
  const [question, setQuestion] = useState("");
  const [sources, setSources] = useState<SourceInput[]>([emptySource()]);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [activeDoc, setActiveDoc] = useState(0);

  useEffect(() => {
    try {
      const k = localStorage.getItem("citelens_key");
      if (k) setApiKey(k);
    } catch {}
  }, []);

  const ranges = useMemo(
    () => (result ? result.sources.map((s, di) => computeRanges(s.content, result.blocks, di)) : []),
    [result]
  );

  function updateSource(i: number, patch: Partial<SourceInput>) {
    setSources((prev) => prev.map((s, si) => (si === i ? { ...s, ...patch } : s)));
  }

  function loadDemo() {
    setResult(DEMO);
    setActiveBlock(null);
    setActiveDoc(0);
    setStage("result");
  }

  async function generate() {
    setError("");
    if (!question.trim()) return setError("Please enter a question.");
    setLoading(true);
    try {
      const prepared: SourceDoc[] = [];
      for (const s of sources) {
        if (s.mode === "text" && s.content.trim()) {
          prepared.push({ title: s.title.trim() || "Pasted text", content: s.content });
        } else if (s.mode === "url" && s.url.trim()) {
          const r = await fetch("/api/extract", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: s.url.trim() }),
          });
          if (!r.ok) {
            setError(`Couldn't extract ${s.url} — open the page and paste its text instead.`);
            return;
          }
          const d = await r.json();
          prepared.push({ title: d.title, content: d.content, url: d.url });
        }
      }
      if (prepared.length === 0) return setError("Add at least one source (URL or pasted text).");
      try {
        localStorage.setItem("citelens_key", apiKey);
      } catch {}
      const r = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, sources: prepared, apiKey: apiKey || undefined }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(
          d.error === "no_key"
            ? "No API key available — add your Anthropic key below, or explore the demo."
            : d.message || "Generation failed, please try again."
        );
        return;
      }
      setResult({ question, sources: prepared, blocks: d.blocks });
      setActiveBlock(null);
      setActiveDoc(0);
      setStage("result");
    } catch {
      setError("Network error, please try again.");
    } finally {
      setLoading(false);
    }
  }

  function selectBlock(i: number, docIndex?: number) {
    if (!result) return;
    setActiveBlock(i);
    const d = docIndex ?? result.blocks[i].citations[0]?.docIndex;
    if (d === undefined) return;
    setActiveDoc(d);
    setTimeout(() => {
      document
        .querySelector(`mark[data-doc="${d}"][data-blocks~="b${i}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }

  function selectRange(r: Range) {
    const b = r.blocks[0];
    setActiveBlock(b);
    document.getElementById(`blk-${b}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ------------------------------ result view ------------------------------ */

  if (stage === "result" && result) {
    return (
      <div className="flex h-screen flex-col bg-stone-50">
        <header className="flex items-center gap-4 border-b border-stone-200 bg-white px-5 py-3">
          <button
            onClick={() => setStage("input")}
            className="shrink-0 rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
          >
            ← New question
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-stone-800 sm:text-base">
            {result.question}
          </h1>
          <div className="hidden shrink-0 items-center gap-3 text-xs text-stone-500 sm:flex">
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-emerald-300" /> cited in sources
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-amber-300" /> no source support
            </span>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
          {/* answer panel */}
          <section className="min-h-0 overflow-y-auto border-b border-stone-200 md:border-b-0 md:border-r">
            <div className="mx-auto max-w-2xl space-y-1 p-5">
              <p className="pb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
                AI answer — click a sentence to locate it in the source
              </p>
              {result.blocks.map((b, i) => {
                const cited = b.citations.length > 0;
                const substantial = b.text.trim().length > 30;
                return (
                  <div
                    key={i}
                    id={`blk-${i}`}
                    onClick={() => selectBlock(i)}
                    className={`cursor-pointer rounded-lg px-3 py-2 transition ${
                      activeBlock === i
                        ? "bg-indigo-50 ring-1 ring-indigo-300"
                        : "hover:bg-stone-100"
                    }`}
                  >
                    <span className="leading-7 text-stone-800">{b.text}</span>
                    {cited ? (
                      <span className="ml-1 inline-flex gap-1 align-middle">
                        {b.citations.map((c, ci) => (
                          <button
                            key={ci}
                            onClick={(e) => {
                              e.stopPropagation();
                              selectBlock(i, c.docIndex);
                            }}
                            title={result.sources[c.docIndex]?.title}
                            className="rounded bg-emerald-100 px-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-200"
                          >
                            {c.docIndex + 1}
                          </button>
                        ))}
                      </span>
                    ) : substantial ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-700">
                        ⚠ no source support
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          {/* source panel */}
          <section className="flex min-h-0 flex-col bg-white">
            <div className="flex gap-1 overflow-x-auto border-b border-stone-200 px-3 pt-2">
              {result.sources.map((s, di) => (
                <button
                  key={di}
                  onClick={() => setActiveDoc(di)}
                  className={`shrink-0 rounded-t-md px-3 py-2 text-xs font-medium ${
                    activeDoc === di
                      ? "border border-b-0 border-stone-200 bg-stone-50 text-stone-800"
                      : "text-stone-500 hover:text-stone-700"
                  }`}
                >
                  <span className="mr-1 rounded bg-emerald-100 px-1 text-emerald-700">{di + 1}</span>
                  {s.title.slice(0, 40)}
                  {s.title.length > 40 ? "…" : ""}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50 p-5">
              {result.sources[activeDoc]?.url && (
                <a
                  href={result.sources[activeDoc].url}
                  target="_blank"
                  rel="noreferrer"
                  className="mb-3 block truncate text-xs text-indigo-500 hover:underline"
                >
                  {result.sources[activeDoc].url}
                </a>
              )}
              <div className="whitespace-pre-wrap leading-7 text-stone-700">
                {(() => {
                  const s = result.sources[activeDoc];
                  const rs = ranges[activeDoc] ?? [];
                  const parts: React.ReactNode[] = [];
                  let pos = 0;
                  rs.forEach((r, ri) => {
                    if (r.start > pos) parts.push(<span key={`t${ri}`}>{s.content.slice(pos, r.start)}</span>);
                    const isActive = activeBlock !== null && r.blocks.includes(activeBlock);
                    parts.push(
                      <mark
                        key={`m${ri}`}
                        data-doc={activeDoc}
                        data-blocks={r.blocks.map((b) => `b${b}`).join(" ")}
                        onClick={() => selectRange(r)}
                        className={`cursor-pointer rounded px-0.5 transition ${
                          isActive
                            ? "bg-indigo-200 ring-2 ring-indigo-400"
                            : "bg-emerald-100 hover:bg-emerald-200"
                        }`}
                      >
                        {s.content.slice(r.start, r.end)}
                      </mark>
                    );
                    pos = r.end;
                  });
                  parts.push(<span key="tail">{s.content.slice(pos)}</span>);
                  return parts;
                })()}
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  /* ------------------------------ input view ------------------------------ */

  return (
    <main className="min-h-screen bg-stone-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-stone-900">
            <span className="text-indigo-600">◎</span> CiteLens
          </h1>
          <p className="mt-2 text-stone-500">
            Ask a question against real sources — then see exactly which sentence of the answer
            comes from exactly which line of the source, side by side.
          </p>
          <button
            onClick={loadDemo}
            className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
          >
            ▶ Explore the demo (no API key needed)
          </button>
        </div>

        <div className="space-y-5 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Question</label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              placeholder="e.g. Does drinking coffee lower the risk of type 2 diabetes?"
              className="w-full resize-none rounded-lg border border-stone-300 p-3 text-sm text-stone-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-medium text-stone-700">Sources (max 3)</label>
            {sources.map((s, i) => (
              <div key={i} className="rounded-lg border border-stone-200 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <button
                    onClick={() => updateSource(i, { mode: "url" })}
                    className={`rounded px-2 py-1 ${s.mode === "url" ? "bg-indigo-100 text-indigo-700" : "text-stone-500 hover:bg-stone-100"}`}
                  >
                    URL
                  </button>
                  <button
                    onClick={() => updateSource(i, { mode: "text" })}
                    className={`rounded px-2 py-1 ${s.mode === "text" ? "bg-indigo-100 text-indigo-700" : "text-stone-500 hover:bg-stone-100"}`}
                  >
                    Paste text
                  </button>
                  <span className="flex-1" />
                  {sources.length > 1 && (
                    <button
                      onClick={() => setSources((prev) => prev.filter((_, si) => si !== i))}
                      className="text-stone-400 hover:text-red-500"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {s.mode === "url" ? (
                  <input
                    value={s.url}
                    onChange={(e) => updateSource(i, { url: e.target.value })}
                    placeholder="https://example.com/article — main text is extracted automatically"
                    className="w-full rounded-md border border-stone-300 p-2 text-sm outline-none focus:border-indigo-400"
                  />
                ) : (
                  <div className="space-y-2">
                    <input
                      value={s.title}
                      onChange={(e) => updateSource(i, { title: e.target.value })}
                      placeholder="Source title (optional)"
                      className="w-full rounded-md border border-stone-300 p-2 text-sm outline-none focus:border-indigo-400"
                    />
                    <textarea
                      value={s.content}
                      onChange={(e) => updateSource(i, { content: e.target.value })}
                      rows={4}
                      placeholder="Paste the source text here…"
                      className="w-full resize-y rounded-md border border-stone-300 p-2 text-sm outline-none focus:border-indigo-400"
                    />
                  </div>
                )}
              </div>
            ))}
            {sources.length < 3 && (
              <button
                onClick={() => setSources((prev) => [...prev, emptySource()])}
                className="text-sm text-indigo-600 hover:underline"
              >
                + Add another source
              </button>
            )}
          </div>

          <details className="rounded-lg bg-stone-50 p-3 text-sm">
            <summary className="cursor-pointer font-medium text-stone-600">
              Anthropic API key (optional)
            </summary>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              className="mt-2 w-full rounded-md border border-stone-300 p-2 text-sm outline-none focus:border-indigo-400"
            />
            <p className="mt-1 text-xs text-stone-400">
              Stored only in your browser (localStorage) and sent only with your own requests. If the
              site is deployed with a server key, you can leave this empty.
            </p>
          </details>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            onClick={generate}
            disabled={loading}
            className="w-full rounded-lg bg-stone-900 py-2.5 font-medium text-white transition hover:bg-stone-700 disabled:opacity-50"
          >
            {loading ? "Reading sources & generating…" : "Generate grounded answer"}
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-stone-400">
          Built with the Anthropic Citations API — every highlight is extracted from the source, not
          generated. · <a className="hover:underline" href="https://github.com/AAAYQ03/citelens">GitHub</a>
        </p>
      </div>
    </main>
  );
}
