// CiteLens in-page highlighter. Injected everywhere but dormant: it only acts
// when this page's URL matches the citation currently open in the panel.
(() => {
  const norm = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname.replace(/\/$/, "");
    } catch {
      return "";
    }
  };

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

  function highlight(claim) {
    const claimTokens = tokenize(claim);
    if (!claimTokens.size) return;
    const blocks = [...document.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, td")]
      .filter((el) => el.innerText && el.innerText.trim().length > 30)
      .map((el) => ({ el, sc: score(claimTokens, tokenize(el.innerText)) }));
    const best = blocks.reduce((m, x) => (x.sc > (m?.sc ?? 0) ? x : m), null);
    if (!best || best.sc < 0.3) return;

    const style = document.createElement("style");
    style.textContent = `
      .citelens-hl { background: rgba(16,185,129,.18) !important; border-radius: 4px; }
      .citelens-hl-best { background: rgba(16,185,129,.28) !important;
        outline: 2px solid #10b981; outline-offset: 2px; border-radius: 4px; }`;
    document.documentElement.appendChild(style);

    blocks.forEach(({ el, sc }) => {
      if (sc >= 0.3 && el !== best.el) el.classList.add("citelens-hl");
    });
    best.el.classList.add("citelens-hl-best");
    setTimeout(() => best.el.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }

  function run() {
    if (!chrome?.storage?.session) return;
    chrome.storage.session.get("pending").then(({ pending }) => {
      if (!pending?.claim) return;
      if (norm(pending.url) !== norm(location.href)) return;
      // Give dynamic pages a moment to settle.
      setTimeout(() => highlight(pending.claim), 800);
    });
  }

  run();
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "session" && ch.pending) run();
    });
  } catch {}
})();
