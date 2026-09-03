// CiteLens content script — ChatGPT adapter.
// Selectors are centralized here so host-DOM changes are a one-line fix.
const SELECTORS = {
  assistantMessage: '[data-message-author-role="assistant"]',
};

const OWN_HOSTS = ["chatgpt.com", "chat.openai.com"];

function claimFor(anchor) {
  const block = anchor.closest("p, li, td, blockquote, h1, h2, h3, div");
  const text = (block?.innerText || anchor.textContent || "")
    .replace(/◎/g, " ") // strip our own ◎ markers
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 400);
}

function decorate(anchor) {
  const btn = document.createElement("button");
  btn.className = "citelens-btn";
  btn.type = "button";
  btn.textContent = "◎"; // ◎
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

function scan() {
  document
    .querySelectorAll(
      `${SELECTORS.assistantMessage} a[href^="http"]:not([data-citelens])`
    )
    .forEach((a) => {
      a.dataset.citelens = "1";
      try {
        const host = new URL(a.href).hostname;
        if (OWN_HOSTS.some((h) => host === h || host.endsWith("." + h))) return;
      } catch {
        return;
      }
      decorate(a);
    });
}

let timer = null;
const observer = new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(scan, 500);
});
observer.observe(document.body, { childList: true, subtree: true });
scan();
