// CiteLens side panel — the source page is the main stage.
// The real page is embedded in an iframe (a per-URL DNR session rule strips
// anti-embedding response headers). Analyze: one Haiku call explains WHY the
// source supports the claim; evidence quotes are validated verbatim and
// annotated into the page by the injected highlighter.

const $ = (id) => document.getElementById(id);
const DNR_RULE_ID = 7001;

let pendingNow = null;
let readerCache = { url: null, article: null };
let analysisCache = { key: null, data: null };

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
function showSrc(url, hint) {
  $("srcbar").hidden = false;
  const a = $("sourceUrl");
  a.textContent = hostnameOf(url);
  a.href = url;
  a.title = url;
  $("srcHint").textContent = hint || "";
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

/* ----------------------------- embed the page ----------------------------- */

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

async function renderPage(pending) {
  const frame = $("frame");
  frame.hidden = false;
  setStatus("");
  showSrc(pending.url, "blank/broken? open in new tab ↗");
  try {
    await allowEmbedding(pending.url);
  } catch {}
  frame.src = pending.url;
}

/* -------------------------------- analysis -------------------------------- */

const cacheKey = (p) => p.url + "||" + p.claim;

function relevantExcerpt(text, claim) {
  if (text.length <= 12000) return text;
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/u).filter((s) => s.trim().length > 0);
  const claimTokens = tokenize(claim);
  let best = null;
  for (const s of sentences) {
    const sc = score(claimTokens, tokenize(s));
    if (!best || sc > best.sc) best = { s, sc };
  }
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
    "If the source does not actually support the claim, say so plainly in the reasoning and cite what it actually says.\n\n" +
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
      setStatus('<p class="error">未能在页面中定位证据 — 试试在新标签页打开 ↗</p>');
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
  const live = await getLiveText(pendingNow.url);
  if (live && live.length > 300) return live;
  const article = await getArticle(pendingNow.url);
  return article.textContent;
}

async function analyze() {
  if (!pendingNow?.claim) return;
  const btn = $("analyzeBtn");
  const { anthropicKey, analysisModel } = await chrome.storage.local.get(["anthropicKey", "analysisModel"]);
  if (!anthropicKey) {
    $("settings").hidden = false;
    $("keyInput").focus();
    setStatus('<p class="error">Add your Anthropic API key first (stored only in this browser).</p>');
    return;
  }
  btn.disabled = true;
  btn.textContent = "Analyzing…";
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
        model: analysisModel || "claude-opus-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: buildPrompt(pendingNow.claim, excerpt) }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "API error");
    const raw = ((data.content || []).find((b) => b.type === "text")?.text || "")
      .replace(/^```(json)?|```$/g, "")
      .trim();
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
  } catch (e) {
    setStatus(`<p class="error">Analysis failed: ${e.message || e}</p>`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze";
  }
}

function focusEvidence(ev) {
  chrome.storage.session.set({ focus: { url: pendingNow.url, quote: ev.quote, ts: Date.now() } });
}

function renderAnalysis(a) {
  $("analysisStrip").hidden = false;
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

function handle(pending) {
  if (!pending?.url) return;
  pendingNow = pending;
  $("emptyHint").hidden = true;
  $("claimCard").hidden = !pending.claim;
  $("claimText").textContent = pending.claim;
  $("claimText").classList.add("clamped");
  if (analysisCache.key !== cacheKey(pending)) {
    $("analysisStrip").hidden = true;
    $("reasoningRow").hidden = true;
    chrome.storage.session.remove("analysis");
  }
  renderPage(pending);
}

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
  await chrome.storage.local.set({
    anthropicKey: $("keyInput").value.trim(),
    analysisModel: $("modelSelect").value,
  });
  $("settings").hidden = true;
  setStatus('<p class="hint">API key saved.</p>');
  setTimeout(() => setStatus(""), 1500);
});

chrome.storage.local.get(["anthropicKey", "analysisModel"]).then(({ anthropicKey, analysisModel }) => {
  if (anthropicKey) $("keyInput").value = anthropicKey;
  if (analysisModel) $("modelSelect").value = analysisModel;
  chrome.storage.session.get("pending").then(({ pending }) => handle(pending));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pending) handle(changes.pending.newValue);
});
