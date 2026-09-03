// CiteLens side panel.
// Original mode: embed the real page in an iframe (a per-URL session rule strips
// the anti-embedding response headers); the injected highlighter locates the passage.
// Reader mode: fetch + Readability, rendered as formatted HTML with block highlights.

const $ = (id) => document.getElementById(id);
const DNR_RULE_ID = 7001;

let pendingNow = null; // current { url, claim }
let readerCache = { url: null, article: null };
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

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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

async function renderReader(pending) {
  $("frame").hidden = true;
  $("frame").src = "about:blank";
  const container = $("content");
  container.hidden = false;
  container.textContent = "";
  setBadge(null);
  setStatus('<p class="empty">Fetching & extracting…</p>');

  try {
    let article = readerCache.url === pending.url ? readerCache.article : null;
    if (!article) {
      const res = await fetch(pending.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      article = new Readability(doc).parse();
      if (!article?.content?.trim()) throw new Error("empty");
      readerCache = { url: pending.url, article };
    }
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
  } catch {
    setStatus(
      '<p class="error">Couldn\'t fetch or extract this page (paywall, bot protection, or dynamic content). Try Original view or open it in a new tab.</p>'
    );
    showMeta(hostnameOf(pending.url), pending.url);
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

chrome.storage.local.get("mode").then(({ mode: m }) => {
  if (m === "reader" || m === "original") mode = m;
  chrome.storage.session.get("pending").then(({ pending }) => handle(pending));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pending) handle(changes.pending.newValue);
});
