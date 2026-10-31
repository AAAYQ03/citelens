# CiteLens eval harness

Measures the quality of the analysis pipeline with the **same validation code the
extension ships** (`extension/core/verify.js`), so eval numbers describe real behavior.

## Metrics

| Metric | How | Where |
| --- | --- | --- |
| JSON validity | `parseAnalysis` succeeds | `asserts/quality.js` |
| Verbatim rate | share of returned quotes that survive verbatim-or-drop | `asserts/quality.js` |
| Evidence count | >= 2 anchored items (>= 1 for adversarial cases) | `asserts/quality.js` |
| Stance correctness | llm-rubric: overstated / contradicted / not_addressed cases must be called out in the reasoning | per-case asserts in `dataset/cases.yaml` |
| Latency & cost | reported by promptfoo per provider | promptfoo output |
| In-product (north star) | analyses count, avg latency, locate rate shown in the panel, stored locally | `chrome.storage.local` |

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx promptfoo@latest eval -c eval/promptfooconfig.yaml
npx promptfoo@latest view     # browse results, compare Sonnet 5 vs Haiku 4.5
```

Deterministic parts run free and fast in CI on every push:

```bash
node --test "tests/*.test.mjs"
```

The model eval runs in CI only on manual dispatch (it costs tokens); add an
`ANTHROPIC_API_KEY` repo secret and trigger the `model-eval` job from the Actions tab.

## Growing the dataset

The seed set has 12 cases (zh/en × supported / overstated / contradicted /
not_addressed). Every real analysis in the panel has a **⤓ case** button that copies a
ready-made case JSON to the clipboard — fill in the `human.stance` label and add it
here. Target: 50 cases harvested from real usage.
