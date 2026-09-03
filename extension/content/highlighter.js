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

  let lastAnalysisTs = 0;
  function applyAnalysis(analysis, attempt = 0) {
    if (analysis.ts && analysis.ts !== lastAnalysisTs) lastAnalysisTs = analysis.ts;
    window.CiteLensAnnotate.annotate(document.body, analysis.evidence || []);
    const done = window.CiteLensAnnotate.appliedCount(document.body);
    const total = (analysis.evidence || []).length;
    if (done < total && attempt < 3) {
      // Dynamic pages may not have rendered the text yet.
      setTimeout(() => applyAnalysis(analysis, attempt + 1), [1500, 3000, 5000][attempt]);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "analysisApplied", url: location.href, count: done, total });
    } catch {}
  }

  // The panel asks for the RENDERED page text (fetched HTML can differ from
  // what the user actually sees: locale variants, JS-rendered content).
  function maybeServeText() {
    chrome.storage.session.get("textRequest").then(({ textRequest }) => {
      if (!textRequest || !isMe(textRequest.url)) return;
      try {
        chrome.runtime.sendMessage({
          type: "pageText",
          url: textRequest.url,
          text: (document.body?.innerText || "").slice(0, 20000),
        });
      } catch {}
    });
  }

  function run() {
    if (!chrome?.storage?.session) return;
    chrome.storage.session.get(["pending", "analysis"]).then(({ pending, analysis }) => {
      if (analysis && isMe(analysis.url) && analysis.evidence?.length) {
        setTimeout(() => applyAnalysis(analysis), 800);
      }
    });
  }

  run();
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "session") return;
      if (ch.pending) run();
      if (ch.textRequest) maybeServeText();
      if (ch.analysis?.newValue && isMe(ch.analysis.newValue.url)) {
        applyAnalysis(ch.analysis.newValue);
      }
      if (ch.focus?.newValue && isMe(ch.focus.newValue.url)) {
        window.CiteLensAnnotate.focus(document.body, ch.focus.newValue.quote);
      }
    });
  } catch {}
})();
