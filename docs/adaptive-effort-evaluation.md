# Adaptive effort paired evaluation

Tracks [the adaptive effort evaluation](https://github.com/Bike4Mind/bike4mind/issues/5224).
No production default is changed. No paid calls are made by this tooling.

## Current decision and exact live-run blockers

Keep the current behavior. No latency or quality win has been established.
This is a blocked evaluation, not evidence that medium preserves quality.

The issue's baseline assumption has changed: `thinkingParams.ts` lists `opus-5-5`
in `MEDIUM_DEFAULT_EFFORT_FAMILIES`. `resolveAnthropicEffort` resolves its unstated
effort to medium; `effortForComplexity` still leaves complex effort undefined.
An omitted-effort arm may therefore already be medium. Confirm the deployed
revision and actual wire behavior before spending on 60 indistinguishable calls.
Do not silently substitute high for the current-default arm.

Missing decisions/access, in order:

1. Confirm whether to compare omission against explicit medium despite identical
   effective effort, or authorize a separately named historical/high baseline.
   The latter is a different experiment, not the issue's current-default arm.
2. Approve a bounded paid run: 60 full-chat completions (30 per arm), plus any
   separately costed classification/grading calls. No retries without approval.
3. Supply an authenticated full-stack target with pinned model/provider, revision,
   settings, read-only sandbox fixtures for tool tasks and request-scoped traces.
   This tool intentionally does not invoke the API or provision the sandbox.
4. Supply an independent blinded reviewer and freeze the tool-task fixture answer
   keys before execution. Generic tool prompts are a candidate corpus, not a
   substitute for a versioned sandbox or correctness oracle.
5. Capture production classifier verdicts and provider effort for each completion.
   Existing latency artifacts lack these fields and request correlation;
   [correlation work](https://github.com/Bike4Mind/bike4mind/issues/7331) is separate.
   Never infer identity from timestamps or ordering.

No credentials were inspected, no model endpoint was called and no spending
approval was requested as part of the offline implementation.

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
provider behavior or reviewer independence. Review the linked evidence before
accepting a study. Unknown provenance is a blocker, never a guessed value.
The analyzer rejects missing/duplicate rows, missing traces, non-complex queries,
retries, restarts, mismatched settings/model, invalid timing and missing grades.
Equal effective arms return `blocked-non-distinct-arms`. Quality/tool regressions
return `keep-default-quality-regression`; otherwise manual review is required.

## Results available now

Only synthetic fixture results exist, in the focused tests: 30 pairs with 1000ms
default and 800ms treatment give a paired median total delta of -200ms. Identical
effective effort is blocked; a tool correctness regression keeps the default.
These numbers validate arithmetic and gates only and are **not model results**.
Actual per-arm latency and quality remain unmeasured pending the blockers above.
Keep raw prompts/responses, tool traces and auth outside the public repository;
publish only sanitized aggregate findings and the decision on the issue.
