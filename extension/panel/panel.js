// CiteLens side panel: fetch the cited page, extract readable text, and
// highlight the sentences that best match the claim.

const $ = (id) => document.getElementById(id);
let currentBest = null; // { sentence, url }

function tokenize(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

// Containment score: how much of the smaller token set is inside the other.
function score(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function setStatus(html) {
  $("status").innerHTML = html;
}

function render(article, claim, url) {
  const title = article.title || new URL(url).hostname;
  const text = article.textContent.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  $("sourceMeta").hidden = false;
  $("sourceTitle").textContent = title;
  $("sourceUrl").textContent = url;
  $("sourceUrl").href = url;

  const claimTokens = tokenize(claim);
  const sentences = splitSentences(text).map((s) => ({ s, score: score(claimTokens, tokenize(s)) }));
  const best = sentences.reduce((m, x) => (x.score > (m?.score ?? 0) ? x : m), null);
  const threshold = 0.35;
  const hasMatch = best && best.score >= threshold && best.s.length > 20;
  currentBest = hasMatch ? { sentence: best.s, url } : { sentence: null, url };

  const badge = $("matchBadge");
  badge.hidden = false;
  if (hasMatch) {
    badge.textContent = best.score >= 0.6 ? "strong match found" : "close match found";
    badge.className = "badge";
  } else {
    badge.textContent = "no clear match in extracted text";
    badge.className = "badge warn";
  }

  const container = $("content");
  container.textContent = "";
  let bestEl = null;
  for (const { s, score: sc } of sentences) {
    let el;
    if (hasMatch && s === best.s) {
      el = document.createElement("mark");
      el.className = "hl hl-best";
      bestEl = el;
    } else if (sc >= threshold && s.length > 20) {
      el = document.createElement("mark");
      el.className = "hl";
    } else {
      el = document.createElement("span");
    }
    el.textContent = s + " ";
    container.appendChild(el);
  }
  if (bestEl) setTimeout(() => bestEl.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
}

function openOriginal() {
  if (!currentBest) return;
  let url = currentBest.url;
  if (currentBest.sentence) {
    const fragment = encodeURIComponent(currentBest.sentence.slice(0, 90).trim())
      .replace(/-/g, "%2D");
    url = url.split("#")[0] + "#:~:text=" + fragment;
  }
  chrome.tabs.create({ url });
}
$("openOriginal").addEventListener("click", openOriginal);

async function handle(pending) {
  if (!pending?.url) return;
  currentBest = { sentence: null, url: pending.url };

  $("claimCard").hidden = !pending.claim;
  $("claimText").textContent = pending.claim;
  $("sourceMeta").hidden = true;
  $("matchBadge").hidden = true;
  $("content").textContent = "";
  setStatus('<p class="empty">Fetching source…</p>');

  try {
    const res = await fetch(pending.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const article = new Readability(doc).parse();
    if (!article?.textContent?.trim()) throw new Error("empty");
    setStatus("");
    render(article, pending.claim || "", pending.url);
  } catch {
    setStatus(
      '<p class="error">Couldn\'t fetch or extract this page (paywall, bot protection, or dynamic content).</p>'
    );
    $("sourceMeta").hidden = false;
    $("sourceTitle").textContent = new URL(pending.url).hostname;
    $("sourceUrl").textContent = pending.url;
    $("sourceUrl").href = pending.url;
    $("openOriginal").textContent = "Open original ↗";
  }
}

chrome.storage.session.get("pending").then(({ pending }) => handle(pending));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pending) handle(changes.pending.newValue);
});
