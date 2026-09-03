// CiteLens background: routes "verify this citation" clicks to the side panel.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Let content scripts (the in-page highlighter) read session storage.
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "openSource" && sender.tab?.id != null) {
    chrome.storage.session.set({
      pending: { url: msg.url, claim: msg.claim || "", ts: Date.now() },
    });
    // Must be called synchronously in the handler so the user gesture is honored.
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  }
});
