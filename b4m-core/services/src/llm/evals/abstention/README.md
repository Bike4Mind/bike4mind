# Forced-retrieval abstention eval

Measures what the abstention block in [`forcedRetrievalAbstention.ts`](../../forcedRetrievalAbstention.ts) actually makes a model do.

## Why this is an eval and not a unit test

The block is injected on **every** ungrounded forced-retrieval turn. The code-level skips are exactly two - an empty prompt, and a turn carrying attached files. Everything else gets the block and is trusted to no-op it via the wording ("For any part of the answer that depends on that library ..."). Forced retrieval is a per-session toggle on ordinary chats, so the residual risk is a trivial follow-up ("thanks") drawing an unprompted apology about library coverage.

That the wording holds is a claim about model behaviour, so it wants a measurement rather than an argument. Two kinds of case:

- **must not mention coverage** - a pleasantry, a "make that shorter", a self-contained arithmetic follow-up. Any coverage language is a false positive the user reads as a malfunction.
- **must hedge** - a genuinely library-dependent question, on each of the three findings. This half makes `unavailable` / `no_match_partial` / `no_match` regression-testable, and the case that matters most is `unavailable`: **an outage must never reach a user as "that document is not in here."**

## What runs where

| File | Runs in CI | What it pins |
|------|:----------:|--------------|
| `../../forcedRetrievalAbstention.test.ts` | yes | The prompt text itself: the conditional framing survives, and no two findings collapse into one |
| `grade.test.ts` | yes | The grader, against fixture replies - a grader nobody tests turns a red eval into a shrug |
| `run.live.test.ts` | no (env-gated) | The behaviour claim, against a real model |

## Running the live half

Point it at any OpenAI-compatible `/chat/completions` endpoint - Ollama, a gateway, a Bedrock proxy:

```bash
# Ollama
ABSTENTION_EVAL_BASE_URL=http://localhost:11434/v1 \
ABSTENTION_EVAL_MODEL=qwen2.5-coder:32b \
ABSTENTION_EVAL_SAMPLES=3 \
  pnpm --filter @bike4mind/services test -- run.live
```

`ABSTENTION_EVAL_SAMPLES` defaults to 3, and a value that is not a positive integer is a hard error rather than a skip - at 0 samples every pass rate is `NaN`, no comparison against it holds, and the suite would go green having called the model zero times.

Prompt behaviour is stochastic; a single sample per case reads noise as signal, and the failure this eval hunts (volunteering coverage language) is intermittent by nature. The suite prints a per-case pass rate and the first failing reason - that report, not the pass/fail, is the deliverable. The assertion gates on a per-case floor (`MIN_PASS_RATE`, two samples in three) rather than full marks, so ordinary sampling noise does not read as a regression; the report labels anything short of 100% but above the floor `WARN`, so the two never disagree about the same rate.

Grading is lexical, not semantic: the failure being measured is the model *volunteering* coverage language, and that failure is lexical. A phrase list will miss an exotic paraphrase; it will not produce a false pass for the blunt phrasings a model actually reaches for. Add patterns to `grade.ts` when a run surfaces one, and add the fixture to `grade.test.ts` in the same change.

Claims are detected per sentence, and an absence scoped to the speaker ("I have no information on that", "no coverage I can point you to") does not count as a claim about the corpus. That distinction is the point of the `unavailable` case: an outage genuinely leaves the model with nothing to offer and the block asks it to say so, but it never establishes that the library lacks the material.
