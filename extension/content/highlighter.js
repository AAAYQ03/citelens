// CiteLens in-page highlighter. Injected everywhere but dormant: it only acts
// when this page's URL matches the citation currently open in the panel.
(() => {
  const ROLE_COLORS = {
    principle: "#6366f1",
    conclusion: "#10b981",
    data: "#f59e0b",
    architecture: "#a855f7",
    condition: "#f43f5e",
    example: "#64748b",
  };
  const ROLE_LABELS = {
    principle: "原理",
    conclusion: "结论",
    data: "数据",
    architecture: "架构",
    condition: "条件",
    example: "例证",
  };

  const norm = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname.replace(/\/$/, "");
    } catch {
      return "";
    }
  };
  const normWs = (s) => s.replace(/\s+/g, " ").trim();
  const isMe = (url) => norm(url) === norm(location.href);

  function tokenize(s) {
    return new Set(
      s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2)
    );
  }
  function score(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / Math.min(a.size, b.size);
  }

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement("style");
    style.textContent = `
      .citelens-hl { background: rgba(16,185,129,.18) !important; border-radius: 4px; }
      .citelens-hl-best { background: rgba(16,185,129,.28) !important;
        outline: 2px solid #10b981; outline-offset: 2px; border-radius: 4px; }
      .citelens-ev { border-radius: 6px; scroll-margin: 120px; }
      .citelens-chip { display: inline-block; margin-right: 6px; padding: 0 7px;
        border-radius: 999px; color: #fff !important; font-size: 11px !important;
        font-weight: 700; line-height: 18px; font-style: normal; vertical-align: 2px; }
      .citelens-flash { outline: 3px solid #4f46e5 !important; outline-offset: 3px;
        transition: outline-color 1s; }`;
    document.documentElement.appendChild(style);
  }

  const blocksOf = () =>
    [...document.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, td")].filter(
      (el) => el.innerText && el.innerText.trim().length > 30
    );

  /* ---- claim fuzzy highlight (static layer) ---- */
  function highlightClaim(claim) {
    const claimTokens = tokenize(claim);
    if (!claimTokens.size) return;
    const blocks = blocksOf().map((el) => ({ el, sc: score(claimTokens, tokenize(el.innerText)) }));
    const best = blocks.reduce((m, x) => (x.sc > (m?.sc ?? 0) ? x : m), null);
    if (!best || best.sc < 0.3) return;
    injectStyle();
    blocks.forEach(({ el, sc }) => {
      if (sc >= 0.3 && el !== best.el) el.classList.add("citelens-hl");
    });
    best.el.classList.add("citelens-hl-best");
    setTimeout(() => best.el.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }

  /* ---- evidence marks (analysis layer) ---- */
  const evidenceEls = new Map(); // normalized quote -> element

  function applyAnalysis(analysis) {
    injectStyle();
    const blocks = blocksOf();
    for (const ev of analysis.evidence || []) {
      const nq = normWs(ev.quote);
      if (evidenceEls.has(nq)) continue;
      const target = blocks.find((el) => normWs(el.innerText).includes(nq));
      if (!target) continue;
      const color = ROLE_COLORS[ev.role] || "#64748b";
      target.classList.remove("citelens-hl", "citelens-hl-best");
      target.classList.add("citelens-ev");
      target.style.setProperty("background", color + "26", "important");
      target.style.setProperty("box-shadow", `inset 3px 0 0 ${color}`, "important");
      target.title = ev.note || "";
      if (!target.querySelector(".citelens-chip")) {
        const chip = document.createElement("span");
        chip.className = "citelens-chip";
        chip.style.background = color;
        chip.textContent = ROLE_LABELS[ev.role] || ev.role;
        target.prepend(chip);
      }
      evidenceEls.set(nq, target);
    }
  }

  function focusQuote(quote) {
    const nq = normWs(quote);
    let el = evidenceEls.get(nq);
    if (!el) el = blocksOf().find((b) => normWs(b.innerText).includes(nq));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("citelens-flash");
    setTimeout(() => el.classList.remove("citelens-flash"), 1200);
  }

  /* ---- wiring ---- */
  function run() {
    if (!chrome?.storage?.session) return;
    chrome.storage.session.get(["pending", "analysis"]).then(({ pending, analysis }) => {
      if (pending?.claim && isMe(pending.url)) {
        setTimeout(() => {
          highlightClaim(pending.claim);
          if (analysis && isMe(analysis.url)) applyAnalysis(analysis);
        }, 800);
      }
    });
  }

  run();
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "session") return;
      if (ch.pending) run();
      if (ch.analysis?.newValue && isMe(ch.analysis.newValue.url)) {
        applyAnalysis(ch.analysis.newValue);
      }
      if (ch.focus?.newValue && isMe(ch.focus.newValue.url)) {
        focusQuote(ch.focus.newValue.quote);
      }
    });
  } catch {}
})();
