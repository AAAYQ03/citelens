// CiteLens content script — ChatGPT adapter.
// Host-DOM selectors live here. ChatGPT renames these attributes every few
// months, so candidates are tried in order and the first that matches wins;
// assistantMessages() reports when none do instead of failing silently.
const MESSAGE_SELECTORS = [
  "[data-dil-message-id]",                  // current (Oct 2026): assistant response renderer root
  "[data-chatgpt-selection-message-id]",
  '[data-message-author-role="assistant"]', // pre-Oct-2026
  "[data-turn-key]",
];
// Citation pills are popover triggers now — the URL is only rendered when the
// popover opens, so we open it programmatically, read the links, and close it.
const PILL_TRIGGER = '[data-d-component="popover-trigger"]';
const MIN_MESSAGE_CHARS = 80; // guards against matching tiny label elements

const OWN_HOSTS = ["chatgpt.com", "chat.openai.com"];
let msgSeq = 0;
let activeSelector = null;
let emptyScans = 0;

function assistantMessages() {
  for (const sel of MESSAGE_SELECTORS) {
    let els;
    try {
      els = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    if (els.length) {
      emptyScans = 0;
      if (activeSelector !== sel) {
        activeSelector = sel;
        console.info("[CiteLens] assistant messages matched by:", sel, "count:", els.length);
      }
      return [...els].filter((el) => {
        if ((el.innerText || "").length < MIN_MESSAGE_CHARS) return false;
        if (el.closest("[data-user-message-bubble]") || el.querySelector("[data-user-message-bubble]")) return false;
        const role = el.getAttribute("data-conversation-role") || el.getAttribute("data-message-author-role");
        return !role || role === "assistant";
      });
    }
  }
  // An empty page or a still-streaming answer legitimately matches nothing;
  // only treat persistent misses on a conversation page as real breakage.
  emptyScans++;
  if (activeSelector !== "none" && emptyScans >= 5 && /^\/c\//.test(location.pathname)) {
    activeSelector = "none";
    console.warn(
      "[CiteLens] no assistant messages matched after repeated scans — ChatGPT's DOM " +
        "may have changed. Update MESSAGE_SELECTORS in content/chatgpt.js."
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

function isExternal(href) {
  try {
    const host = new URL(href).hostname;
    return !OWN_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

function pillsOf(msgEl) {
  return [...msgEl.querySelectorAll("[data-pill]")].filter((p) => p.closest(PILL_TRIGGER));
}

function cachedPillUrls(pill) {
  try {
    return JSON.parse(pill.dataset.citelensUrls || "[]");
  } catch {
    return [];
  }
}

function waitFor(fn, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = fn();
      if (v || Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(v || null);
      }
    }, 60);
  });
}

// Open the pill's popover, read the source links out of it, close it again.
// User-initiated and cached per pill, so each popover flashes at most once.
async function harvestPill(pill) {
  const cached = cachedPillUrls(pill);
  if (cached.length) return cached;
  const trigger = pill.closest(PILL_TRIGGER) || pill;
  const before = new Set(document.querySelectorAll('[role="dialog"]'));
  trigger.click();
  const dlg = await waitFor(() => {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (!before.has(d) && d.querySelector('a[href^="http"]')) return d;
    }
    return null;
  }, 1800);
  let urls = [];
  if (dlg) {
    urls = [...new Set(
      [...dlg.querySelectorAll('a[href^="http"]')].map((a) => a.href).filter(isExternal)
    )];
    if (!urls.length) {
      console.warn("[CiteLens] popover opened but held no external links:", dlg.outerHTML.slice(0, 600));
    }
  } else {
    console.warn("[CiteLens] no popover with links appeared within 1.8s after clicking the pill trigger");
  }
  console.info("[CiteLens] pill harvest:", urls);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  if (trigger.getAttribute("aria-expanded") === "true") trigger.click();
  if (urls.length) pill.dataset.citelensUrls = JSON.stringify(urls);
  return urls;
}

function externalUrls(msgEl) {
  const urls = [];
  for (const a of citationAnchors(msgEl)) if (!urls.includes(a.href)) urls.push(a.href);
  for (const pill of pillsOf(msgEl)) {
    for (const u of cachedPillUrls(pill)) if (!urls.includes(u)) urls.push(u);
  }
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

function decoratePill(pill) {
  const anchorEl = pill.closest(PILL_TRIGGER) || pill;
  if (anchorEl.dataset.citelensDecorated) return;
  anchorEl.dataset.citelensDecorated = "1";
  const btn = document.createElement("button");
  btn.className = "citelens-btn";
  btn.type = "button";
  btn.textContent = "◎";
  btn.title = "CiteLens: open this source beside the answer";
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Open the panel inside the live user gesture — awaiting the harvest
    // first would expire the gesture and sidePanel.open() silently fails.
    chrome.runtime.sendMessage({ type: "openPanel" });
    btn.textContent = "…";
    const urls = await harvestPill(pill);
    if (!urls.length) {
      btn.textContent = "✕";
      btn.title = "CiteLens: couldn't read this citation's URL from its popover (see console)";
      setTimeout(() => (btn.textContent = "◎"), 1500);
      return;
    }
    btn.textContent = "◎";
    chrome.runtime.sendMessage({ type: "openSource", url: urls[0], claim: claimFor(anchorEl) });
  });
  anchorEl.insertAdjacentElement("afterend", btn);
}

function decorateMessage(msgEl) {
  if (!externalUrls(msgEl).length && !pillsOf(msgEl).length) return;
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
    for (const pill of pillsOf(msgEl)) decoratePill(pill);
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
    (async () => {
      scan();
      const all = assistantMessages();
      const msgs = all.filter((m) => externalUrls(m).length || pillsOf(m).length);
      const last = msgs[msgs.length - 1];
      if (!last) {
        sendResponse({
          error: all.length
            ? "no_citations" // messages found, but none cite external sources
            : "no_messages", // selectors no longer match ChatGPT's DOM
        });
        return;
      }
      if (!last.dataset.citelensMsg) decorateMessage(last);
      // Citation URLs live behind popovers now — harvest them one by one.
      for (const pill of pillsOf(last)) await harvestPill(pill);
      sendResponse({
        msgId: last.dataset.citelensMsg,
        text: last.innerText.replace(/◎|Verify answer/g, " ").slice(0, 8000),
        urls: externalUrls(last),
      });
    })();
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
