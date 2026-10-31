// CiteLens content script — ChatGPT adapter.
// Host-DOM selectors live here. ChatGPT renames these attributes every few
// months, so candidates are tried in order and the first that matches wins;
// assistantMessages() reports when none do instead of failing silently.
const MESSAGE_SELECTORS = [
  '[data-conversation-role="assistant"]',   // current (Oct 2026)
  '[data-message-author-role="assistant"]', // previous
  '[data-turn-key][data-conversation-role]',
  "article[data-testid^='conversation-turn']",
];

const OWN_HOSTS = ["chatgpt.com", "chat.openai.com"];
let msgSeq = 0;
let activeSelector = null;

function assistantMessages() {
  for (const sel of MESSAGE_SELECTORS) {
    let els;
    try {
      els = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    if (els.length) {
      if (activeSelector !== sel) {
        activeSelector = sel;
        console.info("[CiteLens] assistant messages matched by:", sel, "count:", els.length);
      }
      return [...els].filter((el) => {
        const role = el.getAttribute("data-conversation-role") || el.getAttribute("data-message-author-role");
        return !role || role === "assistant";
      });
    }
  }
  if (activeSelector !== "none") {
    activeSelector = "none";
    console.warn(
      "[CiteLens] no assistant messages matched — ChatGPT's DOM changed. " +
        "Update MESSAGE_SELECTORS in content/chatgpt.js."
    );
  }
  return [];
}

// A citation can be an anchor, or a pill element wrapping/wrapped by one.
function citationAnchors(msgEl) {
  const found = new Set();
  msgEl.querySelectorAll('a[href^="http"]').forEach((a) => found.add(a));
  msgEl.querySelectorAll("[data-pill]").forEach((pill) => {
    const a = pill.matches('a[href^="http"]')
      ? pill
      : pill.querySelector('a[href^="http"]') || pill.closest('a[href^="http"]');
    if (a) found.add(a);
  });
  return [...found].filter((a) => {
    try {
      const host = new URL(a.href).hostname;
      return !OWN_HOSTS.some((h) => host === h || host.endsWith("." + h));
    } catch {
      return false;
    }
  });
}

const STANCE_FLAGS = {
  overstated: { text: "⚠ 夸大", cls: "citelens-flag-warn" },
  contradicted: { text: "✗ 来源矛盾", cls: "citelens-flag-bad" },
  not_addressed: { text: "⚠ 来源未提及", cls: "citelens-flag-warn" },
};

function externalUrls(msgEl) {
  const urls = [];
  for (const a of citationAnchors(msgEl)) if (!urls.includes(a.href)) urls.push(a.href);
  return urls;
}

function claimFor(anchor) {
  const block = anchor.closest("p, li, td, blockquote, h1, h2, h3, div");
  const text = (block?.innerText || anchor.textContent || "")
    .replace(/◎|Verify answer/g, " ") // strip our own UI text
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 400);
}

function decorate(anchor) {
  const btn = document.createElement("button");
  btn.className = "citelens-btn";
  btn.type = "button";
  btn.textContent = "◎";
  btn.title = "CiteLens: open this source beside the answer";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({
      type: "openSource",
      url: anchor.href,
      claim: claimFor(anchor),
    });
  });
  anchor.insertAdjacentElement("afterend", btn);
}

function decorateMessage(msgEl) {
  const urls = externalUrls(msgEl);
  if (!urls.length) return;
  const msgId = "m" + ++msgSeq;
  msgEl.dataset.citelensMsg = msgId;
  const btn = document.createElement("button");
  btn.className = "citelens-btn citelens-verify-all";
  btn.type = "button";
  btn.textContent = "◎ Verify answer";
  btn.title = "CiteLens: decompose this answer into claims and verify each citation";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({
      type: "openOverview",
      msgId,
      text: msgEl.innerText.replace(/◎ Verify answer/g, " ").slice(0, 8000),
      urls: externalUrls(msgEl),
    });
  });
  msgEl.appendChild(btn);
}

function scan() {
  for (const msgEl of assistantMessages()) {
    for (const a of citationAnchors(msgEl)) {
      if (a.dataset.citelens) continue;
      a.dataset.citelens = "1";
      decorate(a);
    }
    if (!msgEl.dataset.citelensMsg) decorateMessage(msgEl);
  }
}

/* ---- paint overview results back onto the answer ---- */

function tokenize(s) {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2)
  );
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

function paintOverview(result) {
  const msgEl = document.querySelector(`[data-citelens-msg="${result.msgId}"]`);
  if (!msgEl) return;
  msgEl.querySelectorAll(".citelens-flag").forEach((n) => n.remove());
  const blocks = [...msgEl.querySelectorAll("p, li, td, blockquote, h1, h2, h3")].filter(
    (el) => el.innerText && el.innerText.trim().length > 20
  );
  for (const claim of result.claims || []) {
    const flag = STANCE_FLAGS[claim.stance];
    if (!flag) continue; // supported / unverified claims stay unmarked
    const ct = tokenize(claim.text);
    const best = blocks.reduce(
      (m, el) => {
        const sc = overlap(ct, tokenize(el.innerText));
        return sc > m.sc ? { el, sc } : m;
      },
      { el: null, sc: 0 }
    );
    if (!best.el || best.sc < 0.4) continue;
    const chip = document.createElement("button");
    chip.className = `citelens-flag ${flag.cls}`;
    chip.type = "button";
    chip.textContent = flag.text;
    chip.title = claim.reasoning || "";
    if (claim.url) {
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: "openSource", url: claim.url, claim: claim.text });
      });
    }
    best.el.appendChild(chip);
  }
}

try {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "session" && ch.overview?.newValue) paintOverview(ch.overview.newValue);
  });
  // The panel can ask for the newest cited answer, so verifying a long reply
  // doesn't depend on finding the button at the bottom of it.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "getLastAnswer") return;
    scan();
    const all = assistantMessages();
    const msgs = all.filter((m) => externalUrls(m).length);
    const last = msgs[msgs.length - 1];
    if (!last) {
      sendResponse({
        error: all.length
          ? "no_citations" // messages found, but none cite external sources
          : "no_messages", // selectors no longer match ChatGPT's DOM
      });
      return true;
    }
    if (!last.dataset.citelensMsg) decorateMessage(last);
    sendResponse({
      msgId: last.dataset.citelensMsg,
      text: last.innerText.replace(/◎ Verify answer/g, " ").slice(0, 8000),
      urls: externalUrls(last),
    });
    return true;
  });
} catch {}

let timer = null;
const observer = new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(scan, 500);
});
observer.observe(document.body, { childList: true, subtree: true });
scan();
