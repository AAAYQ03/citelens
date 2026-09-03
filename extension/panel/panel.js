// CiteLens side panel.
// Original mode: embed the real page in an iframe (a per-URL session rule strips
// anti-embedding response headers); the injected highlighter locates the passage.
// Reader mode: fetch + Readability, rendered as formatted HTML with block highlights.
// Analyze: one Haiku call explains WHY the source supports the claim, with
// role-labeled verbatim evidence quotes anchored back into the page.

const $ = (id) => document.getElementById(id);
const DNR_RULE_ID = 7001;

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

let pendingNow = null; // current { url, claim }
let readerCache = { url: null, article: null };
let analysisCache = { key: null, data: null }; // key = url + claim
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
function showMeta(title, url) {
  $("sourceMeta").hidden = false;
  $("sourceTitle").textContent = title;
  $("sourceUrl").textContent = url;
  $("sourceUrl").href = url;
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
  setBadge("showing original page", "info");
  setStatus(
    '<p class="hint">Blank or broken? Some sites refuse embedding — switch to Reader view.</p>'
  );
  showMeta(hostnameOf(pending.url), pending.url);
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
  const blocks = [...container.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, td")];
  for (const ev of analysis.evidence) {
    const target = blocks.find((el) => normWs(el.textContent).includes(normWs(ev.quote)));
    if (!target || target.querySelector(".cl-role-chip")) continue;
    const color = ROLE_COLORS[ev.role] || "#64748b";
    target.style.background = color + "22";
    target.style.borderRadius = "6px";
    target.title = ev.note;
    const chip = document.createElement("span");
    chip.className = "cl-role-chip role-chip";
    chip.style.setProperty("--role-color", color);
    chip.style.background = color;
    chip.textContent = ROLE_LABELS[ev.role] || ev.role;
    target.prepend(chip);
  }
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
    showMeta(article.title || hostnameOf(pending.url), pending.url);

    const tpl = document.createElement("template");
    tpl.innerHTML = article.content;
    sanitize(tpl.content, pending.url);
    container.appendChild(tpl.content);

    const best = highlightBlocks(container, pending.claim || "");
    if (best) {
      setBadge(best.sc >= 0.6 ? "strong match found" : "close match found");
      setTimeout(() => best.el.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    } else {
      setBadge("no clear match in article", "warn");
    }
    if (analysisCache.key === cacheKey(pending) && analysisCache.data) {
      applyAnalysisToContainer(container, analysisCache.data);
    }
  } catch {
    setStatus(
      '<p class="error">Couldn\'t fetch or extract this page (paywall, bot protection, or dynamic content). Try Original view or open it in a new tab.</p>'
    );
    showMeta(hostnameOf(pending.url), pending.url);
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
  if (best && best.sc >= 0.25) {
    const i = text.indexOf(best.s);
    if (i >= 0) return text.slice(Math.max(0, i - 2000), i + best.s.length + 2000);
  }
  return text.slice(0, 5000);
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
    '    "role": "principle" | "conclusion" | "data" | "architecture" | "condition" | "example",\n' +
    '    "note": "one short sentence: why this passage matters for the claim, in the language of the CLAIM" }\n' +
    " ]\n" +
    "}\n" +
    "Rules: 2-5 evidence items. Quotes MUST be exact substrings of the EXCERPT (this is validated " +
    "programmatically; paraphrased quotes are discarded). Prefer short quotes (one sentence or clause). " +
    "If the source does not support the claim, set verdict accordingly and cite what it actually says.\n\n" +
    "CLAIM:\n" + claim + "\n\nEXCERPT:\n" + excerpt
  );
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
  btn.textContent = "⚡ Analyzing…";
  try {
    const article = await getArticle(pendingNow.url);
    const excerpt = relevantExcerpt(article.textContent, pendingNow.claim);
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
    // Keep only quotes that really appear in the excerpt (whitespace-tolerant).
    const nx = normWs(excerpt);
    parsed.evidence = (parsed.evidence || [])
      .filter((e) => e?.quote && nx.includes(normWs(e.quote)))
      .slice(0, 5);
    analysisCache = { key: cacheKey(pendingNow), data: parsed };
    renderAnalysis(parsed);
    // Hand the evidence to the in-page highlighter (iframe / opened tabs).
    chrome.storage.session.set({
      analysis: { url: pendingNow.url, evidence: parsed.evidence, ts: Date.now() },
    });
    if (mode === "reader") applyAnalysisToContainer($("content"), parsed);
  } catch (e) {
    setStatus(`<p class="error">Analysis failed: ${e.message || e}</p>`);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Analyze: why does the source support this?";
  }
}

function renderAnalysis(a) {
  const card = $("analysisCard");
  card.hidden = false;
  const v = $("verdict");
  const map = {
    supported: ["✅ 来源支撑该结论", "ok"],
    partial: ["⚠️ 部分支撑", "partial"],
    not_supported: ["❌ 未见支撑", "bad"],
  };
  const [label, cls] = map[a.verdict] || ["—", "partial"];
  v.textContent = label;
  v.className = "pill " + cls;
  $("reasoning").textContent = a.reasoning || "";
  const ul = $("evidenceList");
  ul.textContent = "";
  for (const ev of a.evidence) {
    const li = document.createElement("li");
    const color = ROLE_COLORS[ev.role] || "#64748b";
    li.style.setProperty("--role-color", color);
    const chip = document.createElement("span");
    chip.className = "role-chip";
    chip.textContent = ROLE_LABELS[ev.role] || ev.role;
    const quote = document.createElement("span");
    quote.className = "quote";
    quote.textContent = "“" + ev.quote.slice(0, 120) + (ev.quote.length > 120 ? "…" : "") + "”";
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = ev.note || "";
    li.append(chip, quote, note);
    li.title = "Click to locate in the page";
    li.addEventListener("click", () => {
      chrome.storage.session.set({ focus: { url: pendingNow.url, quote: ev.quote, ts: Date.now() } });
      if (mode === "reader") {
        const blocks = [...$("content").querySelectorAll("p, li, blockquote, h1, h2, h3, h4, td")];
        const t = blocks.find((el) => normWs(el.textContent).includes(normWs(ev.quote)));
        t?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    ul.appendChild(li);
  }
}

/* --------------------------------- routing -------------------------------- */

function renderCurrent() {
  if (!pendingNow) return;
  syncToggle();
  if (mode === "original") renderOriginal(pendingNow);
  else renderReader(pendingNow);
}

function handle(pending) {
  if (!pending?.url) return;
  pendingNow = pending;
  $("claimCard").hidden = !pending.claim;
  $("claimText").textContent = pending.claim;
  $("sourceMeta").hidden = true;
  if (analysisCache.key !== cacheKey(pending)) {
    $("analysisCard").hidden = true;
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
$("settingsBtn").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});
$("keySave").addEventListener("click", async () => {
  await chrome.storage.local.set({ anthropicKey: $("keyInput").value.trim() });
  $("settings").hidden = true;
  setStatus('<p class="hint">API key saved.</p>');
});

chrome.storage.local.get(["mode", "anthropicKey"]).then(({ mode: m, anthropicKey }) => {
  if (m === "reader" || m === "original") mode = m;
  if (anthropicKey) $("keyInput").value = anthropicKey;
  chrome.storage.session.get("pending").then(({ pending }) => handle(pending));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pending) handle(changes.pending.newValue);
});
