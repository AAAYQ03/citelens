// CiteLens side panel — the source page is the main stage.
// The real page is embedded in an iframe (a per-URL DNR session rule strips
// anti-embedding response headers). Analyze: one LLM call (model selectable
// in settings) explains WHY the source supports the claim; evidence quotes are
// validated verbatim (see core/verify.js) and annotated into the page by the
// injected highlighter.

const $ = (id) => document.getElementById(id);
const DNR_RULE_ID = 7001;

let pendingNow = null;
let readerCache = { url: null, article: null };
let analysisCache = { key: null, data: null };

const { relevantExcerpt, buildPrompt, parseAnalysis, validateEvidence, ANALYSIS_SCHEMA,
  splitIntoBlocks, selectBlocks, explodeToSentences, buildCitationsPrompt, parseCitationsResponse,
  DECOMPOSE_SCHEMA, buildDecomposePrompt, validateClaims } = window.CiteLensCore;

const STANCE_UI = {
  supported: ["✓ 支撑", "ok"],
  overstated: ["⚠ 夸大", "warn"],
  contradicted: ["✗ 来源矛盾", "bad"],
  not_addressed: ["⚠ 来源未提及", "warn"],
};

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

const liveTextWaiters = new Map();
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "pageText" && liveTextWaiters.has(msg.url)) {
    liveTextWaiters.get(msg.url)({ text: msg.text || null, blocks: msg.blocks || null });
    liveTextWaiters.delete(msg.url);
  }
  if (msg?.type === "analysisApplied" && pendingNow) {
    updateLastMetricLocated(msg.count);
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

async function getSource() {
  // Prefer the RENDERED text from the embedded page (locale variants and
  // JS-rendered content differ from fetched HTML); fall back to fetching.
  const live = await getLiveText(pendingNow.url);
  if (live?.text && live.text.length > 300) return live;
  const article = await getArticle(pendingNow.url);
  return { text: article.textContent, blocks: null };
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
  const model = analysisModel || "claude-sonnet-5";
  const { engine = "prompt" } = await chrome.storage.local.get("engine");
  const t0 = performance.now();
  try {
    const src = await getSource();
    let body, parsed, excerpt, indexMap = null;
    if (engine === "citations") {
      const blocks = src.blocks?.length ? src.blocks : splitIntoBlocks(src.text);
      const picked = selectBlocks(blocks, pendingNow.claim);
      const sel = explodeToSentences(picked.texts, picked.indexMap);
      excerpt = sel.texts.join("\n");
      indexMap = sel.indexMap;
      body = {
        model,
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "content", content: sel.texts.map((t) => ({ type: "text", text: t })) },
              title: hostnameOf(pendingNow.url),
              citations: { enabled: true },
            },
            { type: "text", text: buildCitationsPrompt(pendingNow.claim) },
          ],
        }],
      };
    } else {
      excerpt = relevantExcerpt(src.text, pendingNow.claim);
      body = {
        model,
        max_tokens: 4000,
        // Structured outputs: the model cannot emit malformed JSON.
        output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
        messages: [{ role: "user", content: buildPrompt(pendingNow.claim, excerpt) }],
      };
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "API error");
    if (engine === "citations") {
      parsed = parseCitationsResponse(data.content, indexMap, body.messages[0].content[0].source.content.map((c) => c.text));
    } else {
      const raw = (data.content || []).find((b) => b.type === "text")?.text || "";
      parsed = parseAnalysis(raw);
    }
    parsed.evidence = validateEvidence(parsed.evidence, excerpt);
    if (engine === "citations" && parsed.evidence.length === 0) {
      // Some models return no citation pointers — fall back to the prompt
      // engine rather than showing an empty analysis.
      setStatus('<p class="hint">Citations engine returned no anchors — falling back to the prompt engine…</p>');
      const fbExcerpt = relevantExcerpt(src.text, pendingNow.claim);
      const fbRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
          messages: [{ role: "user", content: buildPrompt(pendingNow.claim, fbExcerpt) }],
        }),
      });
      const fbData = await fbRes.json();
      if (fbRes.ok) {
        const raw = (fbData.content || []).find((b) => b.type === "text")?.text || "";
        parsed = parseAnalysis(raw);
        excerpt = fbExcerpt;
        parsed.evidence = validateEvidence(parsed.evidence, excerpt);
        setStatus("");
      }
    }
    analysisCache = { key: cacheKey(pendingNow), data: parsed, excerpt, model, engine };
    recordMetric({ ts: Date.now(), model, engine, ms: Math.round(performance.now() - t0), total: parsed.evidence.length });
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

async function recordMetric(m) {
  try {
    const { metrics = [] } = await chrome.storage.local.get("metrics");
    metrics.push(m);
    await chrome.storage.local.set({ metrics: metrics.slice(-200) });
    renderMetrics(metrics);
  } catch {}
}

async function updateLastMetricLocated(count) {
  try {
    const { metrics = [] } = await chrome.storage.local.get("metrics");
    if (metrics.length) {
      metrics[metrics.length - 1].located = count;
      await chrome.storage.local.set({ metrics });
      renderMetrics(metrics);
    }
  } catch {}
}

function renderMetrics(metrics) {
  const el = $("metricsLine");
  if (!el || !metrics.length) return;
  const avgMs = metrics.reduce((s, m) => s + (m.ms || 0), 0) / metrics.length;
  const withLoc = metrics.filter((m) => m.total > 0 && m.located !== undefined);
  const locRate = withLoc.length
    ? withLoc.reduce((s, m) => s + m.located / m.total, 0) / withLoc.length
    : null;
  el.hidden = false;
  el.textContent =
    `${metrics.length} analyses · avg ${(avgMs / 1000).toFixed(1)}s` +
    (locRate !== null ? ` · locate rate ${Math.round(locRate * 100)}%` : "");
}

function focusEvidence(ev) {
  chrome.storage.session.set({ focus: { url: pendingNow.url, quote: ev.quote, ts: Date.now() } });
}

function renderAnalysis(a) {
  $("analysisStrip").hidden = false;
  const flag = $("stanceFlag");
  if (a.stance && a.stance !== "supported" && STANCE_UI[a.stance]) {
    flag.hidden = false;
    flag.textContent = STANCE_UI[a.stance][0];
    flag.className = "flag " + STANCE_UI[a.stance][1];
  } else {
    flag.hidden = true;
  }
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

/* ------------------------------ overview mode ----------------------------- */

async function callClaude(key, body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "API error");
  return data;
}

function ovRow(i, claim) {
  const row = document.createElement("div");
  row.className = "ov-row";
  row.id = "ov-" + i;
  const status = document.createElement("span");
  status.className = "ov-status muted";
  status.textContent = claim.url ? "⏳ queued" : "○ no citation";
  const text = document.createElement("span");
  text.className = "ov-text";
  text.textContent = claim.text;
  row.append(status, text);
  if (claim.url) {
    row.title = claim.url + " — click to inspect this claim against its source";
    row.addEventListener("click", () => {
      chrome.storage.session.set({ pending: { url: claim.url, claim: claim.text, ts: Date.now() } });
    });
  }
  return row;
}

function setOvStatus(i, text, cls) {
  const s = document.querySelector("#ov-" + i + " .ov-status");
  if (s) {
    s.textContent = text;
    s.className = "ov-status " + (cls || "muted");
  }
}

async function enterOverview(req) {
  pendingNow = null;
  $("emptyHint").hidden = true;
  $("claimCard").hidden = true;
  $("analysisStrip").hidden = true;
  $("reasoningRow").hidden = true;
  $("srcbar").hidden = true;
  $("frame").hidden = true;
  setStatus("");
  const ov = $("overview");
  ov.hidden = false;
  $("ovList").textContent = "";
  $("ovSummary").textContent = "Decomposing the answer into atomic claims…";

  const { anthropicKey, analysisModel } = await chrome.storage.local.get(["anthropicKey", "analysisModel"]);
  if (!anthropicKey) {
    $("ovSummary").textContent = "Add your Anthropic API key first (⚙).";
    $("settings").hidden = false;
    return;
  }
  const model = analysisModel || "claude-sonnet-5";

  try {
    // 1) decompose (structured outputs)
    const d = await callClaude(anthropicKey, {
      model,
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: DECOMPOSE_SCHEMA } },
      messages: [{ role: "user", content: buildDecomposePrompt(req.text, req.urls) }],
    });
    const raw = (d.content || []).find((b) => b.type === "text")?.text || "";
    const claims = validateClaims(JSON.parse(raw).claims, req.urls);
    if (!claims.length) {
      $("ovSummary").textContent = "No verifiable claims found in this answer.";
      return;
    }
    claims.forEach((c, i) => $("ovList").appendChild(ovRow(i, c)));
    $("ovSummary").textContent = `${claims.length} claims · fetching sources…`;

    // 2) layer-0 precheck + source fetch (deterministic, parallel, cached per URL)
    const articleText = {};
    const urls = [...new Set(claims.map((c) => c.url).filter(Boolean))];
    await Promise.all(
      urls.map(async (u) => {
        try {
          const a = await getArticle(u);
          articleText[u] = a.textContent;
        } catch {
          articleText[u] = null;
        }
      })
    );
    claims.forEach((c, i) => {
      if (c.url && articleText[c.url] === null) setOvStatus(i, "— unreachable", "muted");
    });

    // 3) parallel verification, concurrency 2, budget cap 6 calls
    const queue = claims
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.url && x.c.verifiable && articleText[x.c.url]);
    const skipped = queue.splice(6);
    skipped.forEach((x) => setOvStatus(x.i, "· skipped (budget)", "muted"));

    async function worker() {
      while (queue.length) {
        const { c, i } = queue.shift();
        setOvStatus(i, "⏳ verifying…", "muted");
        try {
          const excerpt = relevantExcerpt(articleText[c.url], c.text);
          const vd = await callClaude(anthropicKey, {
            model,
            max_tokens: 4000,
            output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
            messages: [{ role: "user", content: buildPrompt(c.text, excerpt) }],
          });
          const vraw = (vd.content || []).find((b) => b.type === "text")?.text || "";
          const parsed = parseAnalysis(vraw);
          parsed.evidence = validateEvidence(parsed.evidence, excerpt);
          c.stance = parsed.stance || "supported";
          c.reasoning = parsed.reasoning;
          const [label, cls] = STANCE_UI[c.stance] || ["?", "muted"];
          setOvStatus(i, label + " · " + parsed.evidence.length + " ev", cls);
          const row = document.getElementById("ov-" + i);
          if (row && c.reasoning) row.title = c.reasoning;
        } catch (e) {
          setOvStatus(i, "error", "bad");
        }
      }
    }
    await Promise.all([worker(), worker()]);

    // 4) aggregate + hand results to the content script for paint-back
    const n = { ok: 0, flag: 0, other: 0 };
    for (const c of claims) {
      if (c.stance === "supported") n.ok++;
      else if (c.stance) n.flag++;
      else n.other++;
    }
    $("ovSummary").textContent =
      `${claims.length} claims · ${n.ok} ✓ supported · ${n.flag} flagged · ${n.other} unverified`;
    chrome.storage.session.set({
      overview: {
        msgId: req.msgId,
        claims: claims.map((c) => ({ text: c.text, url: c.url, stance: c.stance || null, reasoning: c.reasoning || "" })),
        ts: Date.now(),
      },
    });
  } catch (e) {
    $("ovSummary").textContent = "Overview failed: " + (e.message || e);
  }
}

/* --------------------------------- routing -------------------------------- */

function handle(pending) {
  if (!pending?.url) return;
  pendingNow = pending;
  $("overview").hidden = true;
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
$("captureBtn").addEventListener("click", async () => {
  if (!analysisCache.data) return;
  const kase = {
    id: "case-" + Date.now(),
    captured_at: new Date().toISOString(),
    claim: pendingNow?.claim || "",
    source_url: pendingNow?.url || "",
    source_excerpt: analysisCache.excerpt || "",
    model: analysisCache.model || "",
    model_output: analysisCache.data,
    human: { stance: "TODO: supported | overstated | contradicted | not_addressed", notes: "" },
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(kase, null, 2));
    setStatus('<p class="hint">Eval case copied — paste it into eval/dataset/ and fill the human stance label.</p>');
    setTimeout(() => setStatus(""), 3000);
  } catch {}
});
$("expandBtn").addEventListener("click", () => {
  $("reasoningRow").hidden = !$("reasoningRow").hidden;
});
$("verifyAllBtn").addEventListener("click", async () => {
  const btn = $("verifyAllBtn");
  btn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("no active tab");
    const req = await chrome.tabs.sendMessage(tab.id, { type: "getLastAnswer" });
    if (!req) {
      setStatus('<p class="error">No cited ChatGPT answer found in the active tab.</p>');
      return;
    }
    enterOverview({ ...req, ts: Date.now() });
  } catch {
    setStatus('<p class="error">Can\'t reach the page — open a chatgpt.com tab and reload it (Cmd+R) so the extension re-injects.</p>');
  } finally {
    btn.disabled = false;
  }
});
$("settingsBtn").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});
$("keySave").addEventListener("click", async () => {
  await chrome.storage.local.set({
    anthropicKey: $("keyInput").value.trim(),
    analysisModel: $("modelSelect").value,
    engine: $("engineSelect").value,
  });
  $("settings").hidden = true;
  setStatus('<p class="hint">API key saved.</p>');
  setTimeout(() => setStatus(""), 1500);
});

chrome.storage.local.get("metrics").then(({ metrics = [] }) => renderMetrics(metrics));
chrome.storage.local.get(["anthropicKey", "analysisModel", "engine"]).then(({ anthropicKey, analysisModel, engine }) => {
  if (anthropicKey) $("keyInput").value = anthropicKey;
  if (analysisModel) $("modelSelect").value = analysisModel;
  if (engine) $("engineSelect").value = engine;
  chrome.storage.session.get("pending").then(({ pending }) => handle(pending));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.overviewRequest?.newValue) enterOverview(changes.overviewRequest.newValue);
  else if (changes.pending) handle(changes.pending.newValue);
});
chrome.storage.session.get("overviewRequest").then(({ overviewRequest }) => {
  if (overviewRequest && Date.now() - (overviewRequest.ts || 0) < 10000) enterOverview(overviewRequest);
});
