// CiteLens side panel — compact chrome, the source page is the main stage.
// Original mode: real page in an iframe (per-URL DNR rule strips anti-embed headers).
// Reader mode: Readability HTML fallback. Analyze: one Haiku call explains WHY the
// source supports the claim; evidence quotes are validated verbatim and painted
// into the page; the full analysis floats over the viewer instead of pushing it.

const $ = (id) => document.getElementById(id);
const DNR_RULE_ID = 7001;

const VERDICTS = {
  supported: ["✅ 来源支撑该结论", "✅ 支撑", "ok"],
  partial: ["⚠️ 部分支撑", "⚠️ 部分", "partial"],
  not_supported: ["❌ 未见支撑", "❌ 不支撑", "bad"],
};

let pendingNow = null;
let readerCache = { url: null, article: null };
let analysisCache = { key: null, data: null };
let mode = "original";

/* ----------------------------- text matching ----------------------------- */

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
const normWs = (s) => s.replace(/\s+/g, " ").trim();

/* --------------------------------- UI bits -------------------------------- */

function setStatus(html) {
  $("status").innerHTML = html;
}
function setBadge(text, cls) {
  const b = $("matchBadge");
  if (!text) return (b.hidden = true);
  b.hidden = false;
  b.textContent = text;
  b.className = "badge" + (cls ? " " + cls : "");
}
function showSrc(url, hint) {
  $("srcbar").hidden = false;
  const a = $("sourceUrl");
  a.textContent = hostnameOf(url);
  a.href = url;
  a.title = url;
  $("srcHint").textContent = hint || "";
}
function syncToggle() {
  $("modeToggle").hidden = false;
  $("modeOriginal").classList.toggle("active", mode === "original");
  $("modeReader").classList.toggle("active", mode === "reader");
}
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/* ------------------------------ article fetch ----------------------------- */

async function getArticle(url) {
  if (readerCache.url === url && readerCache.article) return readerCache.article;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const article = new Readability(doc).parse();
  if (!article?.content?.trim()) throw new Error("empty");
  readerCache = { url, article };
  return article;
}

/* ------------------------------ original mode ----------------------------- */

async function allowEmbedding(url) {
  let domains;
  try {
    domains = [new URL(url).hostname];
  } catch {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [
      {
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "x-frame-options", operation: "remove" },
            { header: "content-security-policy", operation: "remove" },
          ],
        },
        condition: { requestDomains: domains, resourceTypes: ["sub_frame"] },
      },
    ],
  });
}

async function renderOriginal(pending) {
  $("content").hidden = true;
  const frame = $("frame");
  frame.hidden = false;
  setBadge("original", "info");
  setStatus("");
  showSrc(pending.url, "blank/broken? → switch to Reader");
  try {
    await allowEmbedding(pending.url);
  } catch {}
  frame.src = pending.url;
}

/* ------------------------------- reader mode ------------------------------ */

function sanitize(container, baseUrl) {
  container
    .querySelectorAll("script, iframe, object, embed, form, link, style, noscript, video, audio")
    .forEach((n) => n.remove());
  container.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((at) => {
      if (/^on/i.test(at.name)) el.removeAttribute(at.name);
    });
  });
  container.querySelectorAll("img").forEach((img) => {
    try {
      img.src = new URL(img.getAttribute("src") || "", baseUrl).href;
    } catch {
      img.remove();
      return;
    }
    img.removeAttribute("srcset");
    img.loading = "lazy";
  });
  container.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (/^javascript:/i.test(href)) return a.removeAttribute("href");
    try {
      a.href = new URL(href, baseUrl).href;
      a.target = "_blank";
      a.rel = "noreferrer";
    } catch {}
  });
}

function highlightBlocks(container, claim) {
  const claimTokens = tokenize(claim);
  if (!claimTokens.size) return null;
  const blocks = [...container.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, td")]
    .filter((el) => el.textContent.trim().length > 30)
    .map((el) => ({ el, sc: score(claimTokens, tokenize(el.textContent)) }));
  const best = blocks.reduce((m, x) => (x.sc > (m?.sc ?? 0) ? x : m), null);
  if (!best || best.sc < 0.3) return null;
  blocks.forEach(({ el, sc }) => {
    if (sc >= 0.3 && el !== best.el) el.classList.add("cl-block");
  });
  best.el.classList.add("cl-block-best");
  return best;
}

function applyAnalysisToContainer(container, analysis) {
  window.CiteLensAnnotate.annotate(container, analysis.evidence || []);
}

async function renderReader(pending) {
  $("frame").hidden = true;
  $("frame").src = "about:blank";
  const container = $("content");
  container.hidden = false;
  container.textContent = "";
  setBadge(null);
  setStatus('<p class="empty">Fetching & extracting…</p>');

  try {
    const article = await getArticle(pending.url);
    setStatus("");
    showSrc(pending.url, article.title || "");

    const tpl = document.createElement("template");
    tpl.innerHTML = article.content;
    sanitize(tpl.content, pending.url);
    container.appendChild(tpl.content);

    const best = highlightBlocks(container, pending.claim || "");
    if (best) {
      setBadge(best.sc >= 0.6 ? "strong match" : "close match");
      setTimeout(() => best.el.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    } else {
      setBadge("no clear match", "warn");
    }
    if (analysisCache.key === cacheKey(pending) && analysisCache.data) {
      applyAnalysisToContainer(container, analysisCache.data);
    }
  } catch {
    setStatus(
      '<p class="error">Couldn\'t fetch this page (paywall / bot protection / dynamic). Try Original view or open it in a new tab.</p>'
    );
    showSrc(pending.url, "");
  }
}

/* -------------------------------- analysis -------------------------------- */

const cacheKey = (p) => p.url + "||" + p.claim;

function relevantExcerpt(text, claim) {
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/u).filter((s) => s.trim().length > 0);
  const claimTokens = tokenize(claim);
  let best = null;
  for (const s of sentences) {
    const sc = score(claimTokens, tokenize(s));
    if (!best || sc > best.sc) best = { s, sc };
  }
  if (text.length <= 12000) return text;
  if (best && best.sc >= 0.25) {
    const i = text.indexOf(best.s);
    if (i >= 0) return text.slice(Math.max(0, i - 6000), i + best.s.length + 6000);
  }
  return text.slice(0, 12000);
}

function buildPrompt(claim, excerpt) {
  return (
    "You are a citation-verification assistant. Given a CLAIM from an AI chat answer and an " +
    "EXCERPT of the source it cites, analyze how (and whether) the source supports the claim.\n\n" +
    "Return ONLY valid JSON, no markdown fences:\n" +
    "{\n" +
    ' "verdict": "supported" | "partial" | "not_supported",\n' +
    ' "reasoning": "2-3 sentences explaining the logical chain from source to claim. Write in the same language as the CLAIM.",\n' +
    ' "evidence": [\n' +
    '  { "quote": "EXACT verbatim substring copied character-for-character from the EXCERPT (keep its original language)",\n' +
    '    "label": "a 2-4 character category label in the language of the CLAIM, describing what KIND of content this passage is",\n' +
    '    "note": "one short sentence: why this passage matters for the claim, in the language of the CLAIM" }\n' +
    " ]\n" +
    "}\n" +
    "Label guidance: pick whatever fits THIS article's genre — common ones include " +
    "原理/推导/结论/数据/示例/条件/背景/观点 (or Principle/Reasoning/Conclusion/Data/Example/Condition for English claims), " +
    "but invent a better short label if none fit. Never force a category that does not match the text.\n" +
    "Rules: 2-5 evidence items, each anchored to a DIFFERENT passage (no overlapping quotes). " +
    "When the same idea appears in BOTH an intro/summary paragraph and a detailed section below, " +
    "quote the DETAILED section, not the summary. " +
    "Quotes MUST be exact substrings of the EXCERPT (validated programmatically; paraphrases are discarded). " +
    "Each quote must be ONE sentence or clause, at most ~40 words / 100 characters — never a whole paragraph. " +
    "If the source does not support the claim, set verdict accordingly and cite what it actually says.\n\n" +
    "CLAIM:\n" + claim + "\n\nEXCERPT:\n" + excerpt
  );
}

const liveTextWaiters = new Map();
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "pageText" && liveTextWaiters.has(msg.url)) {
    liveTextWaiters.get(msg.url)(msg.text || null);
    liveTextWaiters.delete(msg.url);
  }
  if (msg?.type === "analysisApplied" && pendingNow) {
    if (msg.count === 0 && msg.total > 0) {
      setStatus('<p class="error">未能在页面中定位证据 — 试试 Reader 视图。</p>');
    } else if (msg.total > 0) {
      setStatus(msg.count < msg.total
        ? `<p class="hint">${msg.count}/${msg.total} evidence located in the page.</p>`
        : "");
    }
  }
});

function getLiveText(url) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      liveTextWaiters.delete(url);
      resolve(null);
    }, 2500);
    liveTextWaiters.set(url, (text) => {
      clearTimeout(t);
      resolve(text);
    });
    chrome.storage.session.set({ textRequest: { url, ts: Date.now() } });
  });
}

async function getSourceText() {
  // Prefer the RENDERED text from the embedded page (locale variants and
  // JS-rendered content differ from fetched HTML); fall back to fetching.
  if (mode === "original") {
    const live = await getLiveText(pendingNow.url);
    if (live && live.length > 300) return live;
  }
  const article = await getArticle(pendingNow.url);
  return article.textContent;
}

async function analyze() {
  if (!pendingNow?.claim) return;
  const btn = $("analyzeBtn");
  const { anthropicKey } = await chrome.storage.local.get("anthropicKey");
  if (!anthropicKey) {
    $("settings").hidden = false;
    $("keyInput").focus();
    setStatus('<p class="error">Add your Anthropic API key first (stored only in this browser).</p>');
    return;
  }
  btn.disabled = true;
  btn.classList.add("spin");
  try {
    const excerpt = relevantExcerpt(await getSourceText(), pendingNow.claim);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages: [{ role: "user", content: buildPrompt(pendingNow.claim, excerpt) }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "API error");
    const raw = (data.content?.[0]?.text || "").replace(/^```(json)?|```$/g, "").trim();
    const parsed = JSON.parse(raw);
    const nx = normWs(excerpt);
    const seen = new Set();
    parsed.evidence = (parsed.evidence || [])
      .filter((e) => {
        if (!e?.quote || normWs(e.quote).length > 300) return false;
        if (!nx.includes(normWs(e.quote))) return false;
        const k = normWs(e.quote);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((e) => ({ ...e, label: normWs(e.label || "").slice(0, 6) || "证据" }))
      .slice(0, 5);
    analysisCache = { key: cacheKey(pendingNow), data: parsed };
    renderAnalysis(parsed);
    chrome.storage.session.set({
      analysis: { url: pendingNow.url, evidence: parsed.evidence, ts: Date.now() },
    });
    if (mode === "reader") applyAnalysisToContainer($("content"), parsed);
  } catch (e) {
    setStatus(`<p class="error">Analysis failed: ${e.message || e}</p>`);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spin");
  }
}

function focusEvidence(ev) {
  chrome.storage.session.set({ focus: { url: pendingNow.url, quote: ev.quote, ts: Date.now() } });
  if (mode === "reader") window.CiteLensAnnotate.focus($("content"), ev.quote);
}

function renderAnalysis(a) {
  const [, mini, cls] = VERDICTS[a.verdict] || ["—", "—", "partial"];

  $("analysisStrip").hidden = false;
  const vm = $("verdictMini");
  vm.textContent = mini;
  vm.className = "pill " + cls;
  const chipRow = $("chipRow");
  chipRow.textContent = "";
  for (const ev of a.evidence) {
    const chip = document.createElement("span");
    chip.className = "role-chip";
    chip.style.setProperty("--role-color", window.CiteLensAnnotate.colorFor(ev.label));
    chip.textContent = ev.label;
    chip.title = ev.note || "";
    chip.addEventListener("click", () => focusEvidence(ev));
    chipRow.appendChild(chip);
  }
  $("reasoning").textContent = a.reasoning || "";
  $("reasoningRow").hidden = true;
}

/* --------------------------------- routing -------------------------------- */

function renderCurrent() {
  if (!pendingNow) return;
  $("emptyHint").hidden = true;
  syncToggle();
  if (mode === "original") renderOriginal(pendingNow);
  else renderReader(pendingNow);
}

function handle(pending) {
  if (!pending?.url) return;
  pendingNow = pending;
  $("claimCard").hidden = !pending.claim;
  $("claimText").textContent = pending.claim;
  $("claimText").classList.add("clamped");
  if (analysisCache.key !== cacheKey(pending)) {
    $("analysisStrip").hidden = true;
    $("reasoningRow").hidden = true;
    chrome.storage.session.remove("analysis");
  }
  renderCurrent();
}

$("modeOriginal").addEventListener("click", () => {
  mode = "original";
  chrome.storage.local.set({ mode });
  renderCurrent();
});
$("modeReader").addEventListener("click", () => {
  mode = "reader";
  chrome.storage.local.set({ mode });
  renderCurrent();
});
$("openOriginal").addEventListener("click", () => {
  if (pendingNow) chrome.tabs.create({ url: pendingNow.url });
});
$("analyzeBtn").addEventListener("click", analyze);
$("claimText").addEventListener("click", () => $("claimText").classList.toggle("clamped"));
$("expandBtn").addEventListener("click", () => {
  $("reasoningRow").hidden = !$("reasoningRow").hidden;
});
$("settingsBtn").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});
$("keySave").addEventListener("click", async () => {
  await chrome.storage.local.set({ anthropicKey: $("keyInput").value.trim() });
  $("settings").hidden = true;
  setStatus('<p class="hint">API key saved.</p>');
  setTimeout(() => setStatus(""), 1500);
});

chrome.storage.local.get(["mode", "anthropicKey"]).then(({ mode: m, anthropicKey }) => {
  if (m === "reader" || m === "original") mode = m;
  if (anthropicKey) $("keyInput").value = anthropicKey;
  chrome.storage.session.get("pending").then(({ pending }) => handle(pending));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pending) handle(changes.pending.newValue);
});
