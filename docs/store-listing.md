# Chrome Web Store 上架材料（复制粘贴用）

## 基本信息

- **Name**: CiteLens — verify AI citations
- **Category**: Productivity → Tools（或 Workflow & Planning）
- **Language**: English（可加中文 listing）

## Summary（短描述，≤132 字符）

See exactly where every AI claim comes from: open cited sources beside the ChatGPT answer, with AI-analyzed evidence highlighted.

## Description（详细描述）

AI answers cite sources as tiny numbered links — but verifying a claim still means opening a
page and hunting for the passage yourself. CiteLens closes that gap, natively on chatgpt.com:

• A ◎ button appears next to every citation in a ChatGPT answer.
• Click it to open the original cited page in Chrome's side panel — full layout, real page.
• Click "Analyze" to close the gap between "the AI said X" and "the source says Y": a
  reasoning chain plus verbatim evidence quotes categorized by role (principle, data,
  conclusion, condition…), highlighted right on the page.
• Evidence is highlighted sentence-precisely inside the live page, with a collapsible
  "why this passage matters" note under each annotated block.

Anti-hallucination by design: every quote is validated as an exact substring of the page text
before it is rendered — an annotation can never point at text that isn't really there.

Bring your own Anthropic API key (stored only in your browser; used only when you click
Analyze). No backend, no data collection. Open source: https://github.com/AAAYQ03/citelens

## 权限用途说明（Privacy practices 页逐项填写）

- **Single purpose**: Verify AI-generated answers against their cited sources by displaying
  and annotating the cited page next to the AI answer.
- **host_permissions `<all_urls>`**: Cited sources can be on any website. The extension needs
  access to display the cited page in the side panel and annotate the exact evidence passages
  on it. It stays dormant except on the page the user is actively verifying.
- **declarativeNetRequest**: Temporarily removes anti-embedding response headers for the
  single cited page the user opens in the side panel, so the original page can render there.
  Rules are session-scoped and per-URL.
- **storage**: Stores the user's own API key and settings locally; coordinates state between
  the side panel and the annotated page.
- **tabs**: Opens the cited source in a new tab when the user clicks "open in new tab".
- **sidePanel**: The extension's main UI.
- **Remote code**: None. All code is packaged.
- **Data usage**: No user data is collected or transmitted to the developer. Page text is sent
  to api.anthropic.com only when the user explicitly clicks Analyze, using the user's own key.
- **Privacy policy URL**: https://github.com/AAAYQ03/citelens/blob/main/PRIVACY.md

## 你需要自己做的步骤

1. https://chrome.google.com/webstore/devconsole 注册开发者（$5，一次性）
2. New item → 上传 `dist/citelens-0.5.2.zip`
3. Store listing：粘贴上面的 Name/Summary/Description；上传 1~5 张 1280×800 截图
   （用现有测试页面截：◎ 按钮特写、侧栏嵌原页、Analyze 标注效果各一张）
4. Privacy practices：按上面逐项粘贴；勾选 "does not collect user data"
5. Distribution → Visibility 选 **Unlisted**（先低调过审）或 Public
6. Submit for review，一般 1–7 天；过审后把商店链接补进 README
