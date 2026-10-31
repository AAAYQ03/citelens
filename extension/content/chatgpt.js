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

const PILL_CACHE_V = "3";

function cachedPillUrls(pill) {
  try {
    if (pill.dataset.citelensUrlsV !== PILL_CACHE_V) return [];
    return JSON.parse(pill.dataset.citelensUrls || "[]");
  } catch {
    return [];
  }
}

function cachePillUrls(pill, urls) {
  pill.dataset.citelensUrls = JSON.stringify(urls);
  pill.dataset.citelensUrlsV = PILL_CACHE_V;
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

// Primary URL source: ChatGPT's own conversation API. The page is
// same-origin, so we can read the session token and fetch the conversation,
// whose assistant messages carry content_references with every citation URL
// (and matched_text anchoring each citation to its answer text). No DOM games.
let convoCache = { id: null, at: 0, refs: [], allUrls: [] };

async function fetchConversationCitations() {
  const convId = location.pathname.match(/\/c\/([0-9a-f-]{20,})/)?.[1];
  if (!convId) return null;
  if (convoCache.id === convId && Date.now() - convoCache.at < 60000) return convoCache;
  try {
    const sess = await fetch("/api/auth/session", { credentials: "include" }).then((r) => r.json());
    const token = sess?.accessToken;
    if (!token) return null;
    const convo = await fetch("/backend-api/conversation/" + convId, {
      credentials: "include",
      headers: { Authorization: "Bearer " + token },
    }).then((r) => (r.ok ? r.json() : null));
    if (!convo?.mapping) return null;
    const byMessage = {};
    const allUrls = [];
    for (const node of Object.values(convo.mapping)) {
      const msgId = node?.message?.id;
      const md = node?.message?.metadata || {};
      const pools = []
        .concat(Array.isArray(md.content_references) ? md.content_references : [])
        .concat(Array.isArray(md.citations) ? md.citations : []);
      for (const ref of pools) {
        const urls = [];
        const push = (u) => {
          if (typeof u === "string" && /^https?:/.test(u) && isExternal(u) && !urls.includes(u)) urls.push(u);
        };
        push(ref.url);
        push(ref.metadata?.url);
        (ref.items || []).forEach((it) => push(it?.url));
        (ref.safe_urls || []).forEach(push);
        (ref.refs || []).forEach((r) => push(r?.url));
        if (!urls.length) continue;
        (byMessage[msgId] = byMessage[msgId] || []).push({
          urls,
          matched: String(ref.matched_text || ref.text || "").replace(/\s+/g, " ").trim(),
          start: ref.start_idx ?? ref.start_ix ?? 0,
        });
        for (const u of urls) if (!allUrls.includes(u)) allUrls.push(u);
      }
    }
    for (const list of Object.values(byMessage)) list.sort((a, b) => a.start - b.start);
    convoCache = { id: convId, at: Date.now(), byMessage, allUrls };
    const nRefs = Object.values(byMessage).reduce((s, l) => s + l.length, 0);
    console.info("[CiteLens] conversation API:", nRefs, "citation refs in", Object.keys(byMessage).length, "messages,", allUrls.length, "urls");
    return convoCache;
  } catch (e) {
    console.warn("[CiteLens] conversation API failed:", e?.message || e);
    return null;
  }
}

function pillText(el) {
  return (el.innerText || "").replace(/\s+/g, " ").trim();
}

// ChatGPT's citation pills navigate on CLICK and show a hover-card with the
// source links on HOVER. So we synthesize a hover (with real coordinates, for
// hover-intent checks), diff the page's anchors before/after to catch the
// card's links wherever they render, then hover out. Never click — that
// navigates the whole tab away.
function fireMouse(el, types) {
  const r = el.getBoundingClientRect();
  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  for (const type of types) {
    el.dispatchEvent(
      type.startsWith("pointer")
        ? new PointerEvent(type, { ...opts, pointerType: "mouse" })
        : new MouseEvent(type, opts)
    );
  }
}

async function harvestPill(pill) {
  const cached = cachedPillUrls(pill);
  if (cached.length) return cached;

  const data = await fetchConversationCitations();
  if (data) {
    // The page scatters several near-identical uuids; walk the ancestors and
    // use whichever one actually exists as a message id in the API data.
    const ID_ATTRS = ["data-dil-message-id", "data-chatgpt-selection-message-id", "data-dil-source-message-id"];
    const candidates = new Set();
    for (let el = pill; el && el !== document.body; el = el.parentElement) {
      for (const a of ID_ATTRS) {
        const v = el.getAttribute?.(a);
        if (v) candidates.add(v);
      }
    }
    let apiId = [...candidates].find((id) => data.byMessage[id]) || null;
    const msgIdsWithRefs = Object.keys(data.byMessage);
    if (!apiId && msgIdsWithRefs.length === 1) {
      // Single cited message in the conversation — no ambiguity to resolve.
      apiId = msgIdsWithRefs[0];
      console.info("[CiteLens] DOM ids", [...candidates], "not in API; using the only cited message", apiId);
    } else if (!apiId) {
      console.warn("[CiteLens] DOM ids", [...candidates], "not found among API messages", msgIdsWithRefs);
    }
    const msgEl = pill.closest(ID_ATTRS.map((a) => "[" + a + "]").join(", "));
    const msgRefs = (apiId && data.byMessage[apiId]) || [];
    const block = pill.closest("p, li, td, blockquote, h1, h2, h3, div");
    const blockText = (block?.innerText || "").replace(/\s+/g, " ").trim();
    let via = null;
    let ref = msgRefs.find(
      (r) => r.matched && r.matched.length > 8 && blockText.includes(r.matched.slice(0, 80))
    );
    if (ref) via = "matched_text";
    if (!ref && msgEl && msgRefs.length) {
      const idx = pillsOf(msgEl).indexOf(pill);
      if (idx >= 0 && msgRefs[idx]) {
        ref = msgRefs[idx];
        via = "pill order";
      }
    }
    let urls = ref?.urls || [];
    if (!urls.length && msgRefs.length) {
      urls = [...new Set(msgRefs.flatMap((r) => r.urls))];
      via = "message pool";
    }
    urls = urls.slice(0, 5);
    if (urls.length) {
      cachePillUrls(pill, urls);
      console.info("[CiteLens] pill harvest (API via " + via + "):", urls);
      return urls;
    }
    console.warn("[CiteLens] API had no refs for message", apiId, "— falling back to hover");
  }

  // Fallback: synthetic hover (works only if the hover-card accepts untrusted events)
  const trigger = pill.closest(PILL_TRIGGER) || pill;
  const beforeAnchors = new Set(document.querySelectorAll('a[href^="http"]'));
  fireMouse(trigger, ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]);
  let urls = await waitFor(() => {
    const fresh = [...document.querySelectorAll('a[href^="http"]')].filter(
      (a) => !beforeAnchors.has(a) && isExternal(a.href)
    );
    return fresh.length ? [...new Set(fresh.map((a) => a.href))] : null;
  }, 1800);
  if (!urls) {
    // some hover-cards open on focus instead
    try { trigger.focus({ preventScroll: true }); } catch {}
    urls = await waitFor(() => {
      const fresh = [...document.querySelectorAll('a[href^="http"]')].filter(
        (a) => !beforeAnchors.has(a) && isExternal(a.href)
      );
      return fresh.length ? [...new Set(fresh.map((a) => a.href))] : null;
    }, 900);
  }
  fireMouse(trigger, ["pointerout", "pointerleave", "mouseout", "mouseleave"]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  urls = urls || [];
  if (!urls.length) {
    console.warn("[CiteLens] hover produced no new external links for this pill");
  }
  console.info("[CiteLens] pill harvest:", urls);
  if (urls.length) cachePillUrls(pill, urls);
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
