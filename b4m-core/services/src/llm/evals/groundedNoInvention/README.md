# Grounded no-invention eval

Measures what [`GROUNDED_NO_INVENTION_RULE`](../../prompts/index.ts) actually makes a model do on the retrieval-**success** path - the turns where retrieval returned content and the rule is spliced in above it.

Sibling of [`../abstention`](../abstention), which measures a different block on the opposite path (forced retrieval that found **no** context). They share [`../harness.ts`](../harness.ts) and nothing else: that eval's grader knows three coverage-claim classes, none of which can express this one's failure.

## The failure this exists to catch

Asked about a specific result the corpus does not contain, the model scopes the absence correctly and then escalates into a verdict on the user's claim:

> I don't have anything in the retrieved knowledge base that supports a [vendor] result of [N]% ... **The premise appears to be fabricated.**

The first half is the wanted behaviour. The last sentence is the defect: the claim was real and simply absent from this corpus. It is worse than abstaining because it reads as adjudicated rather than unknown, and it travels - a rep repeats it to the prospect it was about.

Why a unit test could not catch it: [`prompts/index.test.ts`](../../prompts/index.test.ts) asserts the rule's **text**, and the three call-site tests assert the string is **present**. The rule can be correct, injected, and disobeyed with all of them green.

## Cases

| Kind | Pins |
|------|------|
| `mustNotDenyPremise` | The defect. Absence scoped to the retrieved content, and no ruling on whether the claim is true. |
| `mustAnswer` on a present fact | The control against over-correction - a rule tightened until the model hedges everything would pass the first kind while making the product useless. |
| `mustAnswer` on a derived figure | The derive boundary, worth a measured +25.2 composite and asserted by nothing until now. |

The derive case is honestly scoped: the licence to compute lives in `triage_router` (`apps/client`, not importable here), so this measures the **rule alone** - does it by itself suppress arithmetic the retrieved content supplies the inputs for? That is the direction that matters, and a rule that does not suppress on its own will not suppress with the router's explicit licence added. It is not a substitute for the optihashi-eval re-measurement the rule's docblock asks for before shipping a reword.

The fixture corpus in [`corpus.ts`](./corpus.ts) is entirely invented and must stay that way - this is a public repo. Nothing in it mentions the vendor the premise-challenge cases assert.

## What runs where

| File | Runs in CI | What it pins |
|------|:----------:|--------------|
| `../../prompts/index.test.ts` | yes | The rule text - a reword cannot silently drop a guard |
| `grade.test.ts` | yes | The grader, against fixture replies including the real observed failure |
| `run.live.test.ts` | no (env-gated) | The behaviour claim, against a real model |

## Running the live half

Point it at any OpenAI-compatible `/chat/completions` endpoint - Ollama, a gateway, a Bedrock proxy:

```bash
GROUNDED_EVAL_BASE_URL=http://localhost:11434/v1 \
GROUNDED_EVAL_MODEL=qwen2.5-coder:32b \
GROUNDED_EVAL_SAMPLES=3 \
  pnpm --filter @bike4mind/services test run.live
```

`GROUNDED_EVAL_SAMPLES` defaults to 3, and a value that is not a positive integer is a hard error rather than a skip - at 0 samples every pass rate is `NaN`, no comparison against it holds, and the suite would go green having called the model zero times.

Prompt behaviour is stochastic; a single sample per case reads noise as signal. The suite prints a per-case pass rate and the first failing reason - that report, not the pass/fail, is the deliverable. The assertion gates on a per-case floor (`MIN_PASS_RATE`, two samples in three) rather than full marks, so ordinary sampling noise does not read as a regression.

Grading is lexical, not semantic: the failure is a model reaching for a blunt verdict word ("fabricated", "invented", "no such"), and that failure is lexical. Add patterns to `grade.ts` when a run surfaces one, and add the fixture to `grade.test.ts` in the same change.

Denials are detected per sentence, and a denial the same sentence disclaims ("that does not mean it did not happen") does not count - the wanted answer reaches for the same words the defect does, one sentence later and negated.
