# CiteLens Privacy Policy

Last updated: 2026-09-04

CiteLens is a browser extension that helps users verify AI-generated answers against their
cited sources.

## What data CiteLens handles

- **Anthropic API key (optional):** stored only in your browser via `chrome.storage.local`.
  It is sent exclusively to `api.anthropic.com` with requests you explicitly trigger by
  clicking "Analyze". It is never sent to the developer or any other party.
- **Page content:** when you click "Analyze", the text of the cited source page and the claim
  being verified are sent to the Anthropic API to generate the analysis. Nothing is sent
  anywhere without this explicit action.
- **No collection:** CiteLens has no backend server. It does not collect, store, transmit, or
  sell any personal data, browsing history, or analytics.

## Permissions

- `<all_urls>`: cited sources can be on any website; needed to display and annotate the page
  you are verifying.
- `declarativeNetRequest`: temporarily allows embedding the single cited page you open in the
  side panel.
- `storage`: saves your settings locally and coordinates state between the panel and the page.
- `tabs` / `sidePanel`: opens sources in the side panel or a new tab.

## Contact

Open an issue at https://github.com/AAAYQ03/citelens/issues
