// CiteLens shared annotation engine — used by both the in-page highlighter
// (content script) and the panel's reader mode.
// Sentence-precise coloring via the CSS Custom Highlight API (no DOM mutation
// inside the text), plus one collapsible note element inserted under each
// annotated block (multiple evidence items on the same block share one note).
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

  const BLOCK_SEL = "p, li, blockquote, h1, h2, h3, h4, td, pre";
  const blocksOf = (root) =>
    [...root.querySelectorAll(BLOCK_SEL)].filter(
      (el) => !el.closest(".citelens-note") && normWs(el.textContent).length > 20
    );

  // Build a whitespace-normalized index of a block's text nodes so a quote can
  // be located precisely even when it spans multiple inline elements.
  function rangeIn(block, nq, doc) {
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest(".citelens-note")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
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
    const idx = norm.indexOf(nq);
    if (idx < 0) return null;
    const s = map[idx];
    const e = map[idx + nq.length - 1];
    if (!s || !e) return null;
    const range = doc.createRange();
    range.setStart(s.n, s.i);
    range.setEnd(e.n, e.i + 1);
    return range;
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

  function annotate(root, evidence) {
    const doc = root.ownerDocument || document;
    ensureStyle(doc);
    const st = stateFor(root);
    const blocks = blocksOf(root);
    let applied = 0;
    for (const ev of evidence || []) {
      const nq = normWs(ev.quote || "");
      const label = normWs(ev.label || "") || "证据";
      if (!nq || st.applied.has(nq)) continue;
      let hit = null;
      for (const b of blocks) {
        const r = rangeIn(b, nq, doc);
        if (r) {
          hit = { b, r };
          break;
        }
      }
      if (!hit) continue;
      st.applied.add(nq);
      st.quoteBlock.set(nq, hit.b);
      paint(doc, hit.r, colorFor(label));
      addNote(doc, st, hit.b, { ...ev, label });
      applied++;
    }
    return applied;
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

  return { annotate, focus, colorFor };
})();
