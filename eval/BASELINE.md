# Baseline: eval-yde-2026-10-31

First full run of the 12-case seed set (prompt engine, no structured outputs yet),
2 providers × 12 cases = 24 runs. Grader: Sonnet 5.

| Provider | Pass | Notes |
| --- | --- | --- |
| claude-sonnet-5 | **12/12 (100%)** | all stances handled, zh and en |
| claude-haiku-4-5 | **8/12 (67%)** | 4 failures, see taxonomy |

Cost of the run: ~32k tokens total (≈ a few cents). Duration 28s at concurrency 4.

## Failure taxonomy (all 4 on Haiku)

| Case | Failure class | Root cause | Fix |
| --- | --- | --- | --- |
| zh/zh supported (新闻稿) | quote drift | returned 1 evidence, 0 verbatim — zh quote altered in transcription | citations engine (quotes extracted by the API, not generated) |
| zh/zh contradicted (补贴) | malformed JSON | unescaped quote inside a JSON string | structured outputs (`output_config.format`) |
| zh→en not_addressed (平板) | malformed JSON | trailing text after the JSON object | structured outputs |
| en not_addressed (license) | empty evidence | reasoning was correct but 0 quotes returned; spec requires citing what the source actually covers | model capability; tracked, not spec-relaxed |

## Decisions taken from this baseline

1. **Sonnet 5 as default is now data-backed** (was chosen on feel in v0.5.3).
2. **Structured outputs added to the prompt engine** — eliminates the malformed-JSON
   class (2/4 failures) by construction. Citations can't be combined with structured
   outputs in one request, which is why they live in separate engines.
3. **Citations engine added (experimental)** — quotes become API-extracted pointers,
   eliminating the quote-drift class (1/4). Promotion to default is gated on the next
   eval run beating this baseline on anchor metrics without regressing stance calls.

Reproduce: `ANTHROPIC_API_KEY=... npx promptfoo@latest eval -c eval/promptfooconfig.yaml`
(config now runs the 2 engines × 2 models matrix = 48 calls).
