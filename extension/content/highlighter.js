// CiteLens in-page highlighter. Injected everywhere but dormant: it only acts
// when this page's URL matches the citation currently open in the panel.
// Annotation itself lives in annotate.js (shared with the panel's reader mode).
(() => {
  const norm = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname.replace(/\/$/, "");
    } catch {
      return "";
    }
  };
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
        outline: 2px solid #10b981; outline-offset: 2px; border-radius: 4px; }`;
    document.documentElement.appendChild(style);
  }

  /* ---- claim fuzzy highlight (static layer, before analysis exists) ---- */
  function highlightClaim(claim) {
    const claimTokens = tokenize(claim);
    if (!claimTokens.size) return;
    const blocks = [...document.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, td")]
      .filter((el) => el.innerText && el.innerText.trim().length > 30 && !el.closest(".citelens-note"))
      .map((el) => ({ el, sc: score(claimTokens, tokenize(el.innerText)) }));
    const best = blocks.reduce((m, x) => (x.sc > (m?.sc ?? 0) ? x : m), null);
    if (!best || best.sc < 0.3) return;
    injectStyle();
    blocks.forEach(({ el, sc }) => {
      if (sc >= 0.3 && el !== best.el) el.classList.add("citelens-hl");
    });
    best.el.classList.add("citelens-hl-best");
    setTimeout(() => best.el.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }

  function clearClaimHl() {
    document.querySelectorAll(".citelens-hl, .citelens-hl-best").forEach((el) => {
      el.classList.remove("citelens-hl", "citelens-hl-best");
    });
  }

  function applyAnalysis(analysis) {
    // Evidence-level annotation replaces the coarse claim highlight.
    clearClaimHl();
    window.CiteLensAnnotate.annotate(document.body, analysis.evidence || []);
  }

  function run() {
    if (!chrome?.storage?.session) return;
    chrome.storage.session.get(["pending", "analysis"]).then(({ pending, analysis }) => {
      if (pending?.claim && isMe(pending.url)) {
        setTimeout(() => {
          if (analysis && isMe(analysis.url) && analysis.evidence?.length) {
            applyAnalysis(analysis);
          } else {
            highlightClaim(pending.claim);
          }
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
        window.CiteLensAnnotate.focus(document.body, ch.focus.newValue.quote);
      }
    });
  } catch {}
})();
