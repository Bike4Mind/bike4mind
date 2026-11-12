# Adaptive effort paired evaluation

Tracks [the adaptive effort evaluation](https://github.com/Bike4Mind/bike4mind/issues/5224).
No production default is changed. No paid calls are made by this tooling.

The omitted-effort arm may already resolve to medium: `thinkingParams.ts` lists
`opus-5-5` in `MEDIUM_DEFAULT_EFFORT_FAMILIES`. Confirm the deployed revision and
actual wire behavior before a live run; equal effective arms are reported as
`blocked-non-distinct-arms`. Do not silently substitute high for the default arm.

## Reproduce offline

From the repository root (Node 24+):

```sh
node scripts/adaptive-effort-eval.mjs plan
VITEST_MAX_WORKERS=25% pnpm exec vitest run scripts/__tests__/adaptive-effort-eval.test.mjs
node scripts/adaptive-effort-eval.mjs analyze /absolute/private/path/observations.json
```

`plan` prints a stable SHA-256 corpus hash, 10 long-form, 10 reasoning and 10
multi-step tool tasks and a 60-observation schedule. Even-numbered pairs start
with default, odd-numbered pairs with medium. This counterbalances first-arm
position but is not randomized; report the order and temporal drift limitation.
Prompts are candidates until classified **complex by the production path** with
the real settings. If any fail that criterion, revise and freeze the corpus
before starting either arm; do not drop observations after seeing outcomes.

Send only each entry's `prompt` to the model. Its separate `rubric` is for the
reviewer, never model input. Removing rubrics from prompts changes `corpusHash`;
observations from the previous answer-key-containing corpus cannot be reused.

## Live protocol after approval

1. Freeze the corpus hash, stack revision, exact model/provider, fixture revision,
   tool inventory, system prompt, output budget and all other chat settings.
   Record their canonical JSON SHA-256 as `environmentHash`; only the explicit
   effort override differs. Disable model routing/fallback and external mutable
   tools. Use the same fresh-session snapshot for both members of every pair.
2. Run serially in plan order through the full chat stack, not a raw provider
   benchmark. Default omits explicit effort; treatment sends medium through the
   existing chat preference path. Verify the **provider request**, including any
   output-ceiling downgrade, rather than assuming the UI setting reached it.
3. Measure send-to-first-visible-answer and send-to-turn-completion with the same
   monotonic clock. Completion includes tools and artifact settling. Keep raw
   responses and all failed attempts privately. A timeout, fallback or retry blocks
   this complete-pair analysis; do not rerun only the slow or incorrect arm.
4. Give the reviewer anonymous A/B outputs with arm labels, timing, model effort
   and schedule hidden. Counterbalance A/B placement. Review against each rubric:
   0 unusable, 1 major errors, 2 material omissions, 3 correct with minor omissions,
   4 complete and correct. Record correctness separately. Audit tool calls,
   results and claimed execution against the frozen answer key; no keyword-only
   grading. Keep the blinded packet and mapping as separate private artifacts.
   Keep raw prompts/responses, tool traces and auth outside the public repository.
5. Analyze the complete 30 pairs. Report both arm medians, paired median deltas,
   quality means, correctness and tool correctness counts. Inspect each paired
   regression. Thirty pairs are exploratory, not proof of non-inferiority; obtain
   uncertainty estimates and an independent quality sign-off before any proposal
   to change defaults. The analyzer never returns an automatic ship decision.

## Observation format

The input has `schemaVersion: 1`, the plan's `corpusHash`, and `rows` containing
exactly one observation per `(promptId, arm)`. Each row requires:

| Field                              | Meaning                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| `promptId`, `arm`                  | Plan ID; arm is `default` or `medium`                                |
| `requestId`                        | Actual unique completion correlation ID, not a generated ordinal     |
| `complexity`, `classifierEvidence` | `complex`; private trace reference                                   |
| `status`, `attempt`, `restarts`    | `completed`, `0`, `0` for this complete-pair analysis                |
| `model`                            | `claude-opus-5-5`, with exact provider version pinned in environment |
| `requestedEffort`                  | `null` for default; `medium` for treatment                           |
| `effectiveEffort`, `wireEvidence`  | Verified provider effort and private trace reference                 |
| `environmentHash`                  | Same 64-character lowercase SHA-256 for every observation            |
| `response`                         | Full final answer, stored privately                                  |
| `firstTokenMs`, `totalMs`          | Positive finite timings; total includes tools                        |
| `quality`, `correct`               | Integer 0-4 and boolean from independent review                      |
| `blindReviewId`, `gradeEvidence`   | Blinded packet ID and private rubric rationale reference             |
| `toolCorrect`, `toolEvidence`      | Boolean and private audit reference, mandatory for tool tasks        |

Evidence references are operator attestations, not cryptographic verification of
provider behavior or reviewer independence. `blindReviewId` is only checked for
presence; the analyzer does not verify how outputs were blinded or paired.
Review the linked evidence before
accepting a study. Unknown provenance is a blocker, never a guessed value.
The analyzer rejects missing/duplicate rows, missing traces, non-complex queries,
retries, restarts, mismatched settings/model, invalid timing and missing grades.
Equal effective arms return `blocked-non-distinct-arms`. Quality/tool regressions
return `keep-default-quality-regression`; otherwise manual review is required.
