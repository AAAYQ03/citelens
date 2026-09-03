// CiteLens shared annotation engine — used by both the in-page highlighter
// (content script) and the panel's reader mode.
// Quotes are located with a whitespace-normalized index over the WHOLE root
// (works on div-heavy pages, quotes crossing inline elements), colored via the
// CSS Custom Highlight API (no DOM mutation inside text), and each annotated
// block gets one collapsible note under it.
window.CiteLensAnnotate = (() => {
  const FIXED = {
    "原理": "#6366f1", "推导": "#8b5cf6", "结论": "#10b981", "数据": "#f59e0b",
    "示例": "#64748b", "条件": "#f43f5e", "背景": "#0ea5e9", "观点": "#d946ef",
    "Principle": "#6366f1", "Reasoning": "#8b5cf6", "Conclusion": "#10b981",
    "Data": "#f59e0b", "Example": "#64748b", "Condition": "#f43f5e",
  };
  const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#a855f7", "#f43f5e",
    "#0ea5e9", "#d946ef", "#64748b", "#84cc16", "#f97316"];
  const ALLCOLORS = [...new Set([...Object.values(FIXED), ...PALETTE])];

  const colorFor = (label) => {
    if (FIXED[label]) return FIXED[label];
    let h = 0;
    for (const c of String(label)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
  const normWs = (s) => String(s).replace(/\s+/g, " ").trim();

  const state = new WeakMap(); // root -> { applied, notes, quoteBlock }
  function stateFor(root) {
    if (!state.has(root))
      state.set(root, { applied: new Set(), notes: new Map(), quoteBlock: new Map() });
    return state.get(root);
  }

  function ensureStyle(doc) {
    if (doc.getElementById("citelens-annotate-style")) return;
    const style = doc.createElement("style");
    style.id = "citelens-annotate-style";
    style.textContent =
      ALLCOLORS.map((c, i) => `::highlight(citelens-hl-${i}) { background-color: ${c}4d; }`).join("\n") +
      `
      .citelens-note { margin: 4px 0 12px; font-size: 12.5px; line-height: 1.5; font-style: normal; }
      .citelens-note .cl-head { display: flex; align-items: center; gap: 6px; width: 100%;
        text-align: left; border: none; border-left: 3px solid #94a3b8;
        background: rgba(148, 163, 184, 0.12); padding: 4px 8px;
        border-radius: 0 8px 8px 0; cursor: pointer; color: inherit; font: inherit; font-size: 12.5px; }
      .citelens-note .cl-chips { flex-shrink: 0; display: flex; gap: 4px; }
      .citelens-note .cl-summary { flex: 1; min-width: 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
      .citelens-note .cl-arrow { flex-shrink: 0; opacity: 0.6; }
      .citelens-note .cl-body { padding: 4px 8px 2px 11px; }
      .citelens-note .cl-row { display: flex; gap: 6px; margin: 3px 0; align-items: baseline; }
      .citelens-chip { flex-shrink: 0; display: inline-block; padding: 0 7px; border-radius: 999px;
        color: #fff !important; font-size: 10px !important; font-weight: 700;
        line-height: 17px; font-style: normal; white-space: nowrap; }
      .citelens-flash { outline: 3px solid #4f46e5 !important; outline-offset: 3px; }`;
    (doc.head || doc.documentElement).appendChild(style);
  }

  const SKIP = "script, style, noscript, textarea, svg, .citelens-note";

  // Whitespace-normalized character index over every visible text node in root.
  function buildIndex(root, doc) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        try {
          if (p.checkVisibility && !p.checkVisibility()) return NodeFilter.FILTER_REJECT;
        } catch {}
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let norm = "";
    const map = [];
    let lastSpace = true;
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue;
      for (let i = 0; i < t.length; i++) {
        if (/\s/.test(t[i])) {
          if (!lastSpace) {
            norm += " ";
            map.push({ n, i });
            lastSpace = true;
          }
        } else {
          norm += t[i];
          map.push({ n, i });
          lastSpace = false;
        }
      }
    }
    return { norm, map };
  }

  function rangeFromIndex(index, nq, doc) {
    const idx = index.norm.indexOf(nq);
    if (idx < 0) return null;
    const s = index.map[idx];
    const e = index.map[idx + nq.length - 1];
    if (!s || !e) return null;
    const range = doc.createRange();
    range.setStart(s.n, s.i);
    range.setEnd(e.n, e.i + 1);
    return range;
  }

  // The element the note should hang under: the smallest block containing the
  // whole quote.
  function blockFor(range) {
    let el = range.commonAncestorContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    return el?.closest("p, li, blockquote, h1, h2, h3, h4, td, pre") || el;
  }

  function paint(doc, range, color) {
    if (typeof Highlight === "undefined" || !doc.defaultView?.CSS?.highlights) return;
    const reg = doc.defaultView.CSS.highlights;
    const name = "citelens-hl-" + ALLCOLORS.indexOf(color);
    let h = reg.get(name);
    if (!h) {
      h = new doc.defaultView.Highlight();
      reg.set(name, h);
    }
    h.add(range);
  }

  function mkChip(doc, label) {
    const chip = doc.createElement("span");
    chip.className = "citelens-chip";
    chip.style.background = colorFor(label);
    chip.textContent = label;
    return chip;
  }

  function addNote(doc, st, block, ev) {
    let note = st.notes.get(block);
    if (!note) {
      note = doc.createElement("div");
      note.className = "citelens-note";
      const head = doc.createElement("button");
      head.className = "cl-head";
      head.type = "button";
      head.title = "CiteLens: why this passage matters — click to expand";
      const chips = doc.createElement("span");
      chips.className = "cl-chips";
      const summary = doc.createElement("span");
      summary.className = "cl-summary";
      const arrow = doc.createElement("span");
      arrow.className = "cl-arrow";
      arrow.textContent = "▾";
      head.append(chips, summary, arrow);
      const body = doc.createElement("div");
      body.className = "cl-body";
      body.hidden = true;
      head.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        body.hidden = !body.hidden;
        arrow.textContent = body.hidden ? "▾" : "▴";
        summary.style.visibility = body.hidden ? "visible" : "hidden";
      });
      note.append(head, body);
      block.insertAdjacentElement("afterend", note);
      st.notes.set(block, note);
    }
    note.querySelector(".cl-chips").appendChild(mkChip(doc, ev.label));
    const summary = note.querySelector(".cl-summary");
    if (!summary.textContent) summary.textContent = ev.note || "";
    const row = doc.createElement("div");
    row.className = "cl-row";
    const t = doc.createElement("span");
    t.textContent = ev.note || "";
    row.append(mkChip(doc, ev.label), t);
    note.querySelector(".cl-body").appendChild(row);
  }

  // Returns how many evidence items were newly anchored. Safe to call again
  // (e.g. after dynamic content loads): already-applied quotes are skipped.
  function annotate(root, evidence) {
    const doc = root.ownerDocument || document;
    ensureStyle(doc);
    const st = stateFor(root);
    const remaining = (evidence || []).filter((ev) => {
      const nq = normWs(ev.quote || "");
      return nq && !st.applied.has(nq);
    });
    if (!remaining.length) return 0;
    const index = buildIndex(root, doc);
    let applied = 0;
    for (const ev of remaining) {
      const nq = normWs(ev.quote);
      const label = normWs(ev.label || "") || "证据";
      const range = rangeFromIndex(index, nq, doc);
      if (!range) continue;
      st.applied.add(nq);
      const block = blockFor(range);
      st.quoteBlock.set(nq, block);
      paint(doc, range, colorFor(label));
      addNote(doc, st, block, { ...ev, label });
      applied++;
    }
    return applied;
  }

  function appliedCount(root) {
    return stateFor(root).applied.size;
  }

  function focus(root, quote) {
    const st = stateFor(root);
    const el = st.quoteBlock.get(normWs(quote));
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("citelens-flash");
    setTimeout(() => el.classList.remove("citelens-flash"), 1200);
    return true;
  }

  return { annotate, focus, colorFor, appliedCount };
})();
