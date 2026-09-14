# Grounded no-invention eval

Measures what [`GROUNDED_NO_INVENTION_RULE`](../../prompts/index.ts) actually makes a model do on the retrieval-**success** path - the turns where retrieval returned content and the rule is spliced in above it.

Sibling of [`../abstention`](../abstention), which measures a different block on the opposite path (forced retrieval that found **no** context). They share [`../harness.ts`](../harness.ts) and nothing else: that eval's grader knows three coverage-claim classes, none of which can express this one's failure.

## The failure this exists to catch

Asked about a specific result the corpus does not contain, the model scopes the absence correctly and then escalates into a verdict on the user's claim:

> I don't have anything in the retrieved knowledge base that supports a [vendor] result of [N]% ... **The premise appears to be fabricated.**

The first half is the wanted behaviour. The last sentence is the defect: the claim was real and simply absent from this corpus. It is worse than abstaining because it reads as adjudicated rather than unknown, and it travels - a rep repeats it to the prospect it was about.

**And the failure it turns into when you fix it.** The clauses that stopped the adjudication tell the model to report the gap and *leave the claim itself open*. A paired production measurement found the other half of that dial: the model stops ruling on the claim and starts supplying it instead - an asserted mechanism, cited benchmarks, invented percentages presented as published, a comparison baseline the corpus never named. Every one of those replies names the gap correctly and rules on nothing, so the two original checks pass them. Denial and supply are one instruction with two failure directions, which is why they are graded by one grader rather than two.

Why a unit test could not catch it: [`prompts/index.test.ts`](../../prompts/index.test.ts) asserts the rule's **text**, and the three call-site tests assert the string is **present**. The rule can be correct, injected, and disobeyed with all of them green.

## Cases

| Kind | Pins |
|------|------|
| `mustNotDenyPremise` | The defect. The gap named, and no ruling on whether the claim is true. Three phrasings; see the measurement below for why only one of them discriminates. |
| `mustNotDenyPremise` on an invitation to elaborate | The supply direction, which the three phrasings above cannot draw: `invites-elaboration` asks what the absent result was measured against and how it was validated, so declining the verdict costs the model nothing and the honest answer is still to leave the whole thing unanswered. |
| `mustAnswer` on a present fact | The control against over-correction - a rule tightened until the model hedges everything would pass the first kind while making the product useless. |
| `mustAnswer` on a supported claim | The control for the decline-the-yes/no clause. Same "is that accurate?" shape as the defect case, but the corpus carries the answer, so a model that learned to refuse every accuracy question fails here and nowhere else. |
| `mustAnswer` on a contradicted claim | The direction with the business consequence: the corpus does not just lack the claim (Pinebrook is on record at 18%, not the asserted 40%), it disagrees with it. The wanted answer corrects the user and legitimately reads as a denial of the premise - `PREMISE_DENIAL`'s strictness is scoped to absence, not contradiction, so `gradeMustAnswer` passes it on the strength of the real figure alone. |
| `mustAnswer` on a derived figure | The derive boundary, worth a measured +25.2 composite and asserted by nothing until now. |
| `mustAnswer` on a supported mechanism | The control for the clause defining what leaving a claim open means. That clause forbids explaining how an **absent** result was reached; `explain-supported-mechanism` asks what drove a reduction the corpus itself attributes ("fewer empty return legs"), and is the only case that catches a model that stopped explaining mechanisms it retrieved. |

The derive case is honestly scoped: the licence to compute lives in `triage_router` (`apps/client`, not importable here), so this measures the **rule alone** - does it by itself suppress arithmetic the retrieved content supplies the inputs for? That is the direction that matters, and a rule that does not suppress on its own will not suppress with the router's explicit licence added. It is not a substitute for the optihashi-eval re-measurement the rule's docblock asks for before shipping a reword.

The fixture corpus in [`corpus.ts`](./corpus.ts) is entirely invented and must stay that way - this is a public repo. Nothing in it mentions the vendor the premise-challenge cases assert.

## What runs where

| File | Runs in CI | What it pins |
|------|:----------:|--------------|
| `../../prompts/index.test.ts` | yes | The rule text - a reword cannot silently drop a guard |
| `grade.test.ts` | yes | The grader, against fixture replies including the real observed failure |
| `run.live.test.ts` | no (env-gated) | The behaviour claim, against a real model |

## What it measured

Two harnesses, and the difference between them is the most useful thing in this file.

**This eval's own harness** (the corpus in `corpus.ts`, the rule spliced in directly, `gpt-4.1-2025-04-14`,
both arms in one run) put the base-branch rule at **3 failures in 12** on
`premise-challenge/asked-to-adjudicate`, and the branch at **0 in 12**. Every other case was clean on
both arms, and `gpt-4o` never produced the defect on either.

**The full retrieval stack** - the same cases and the same grader, but driven through `/api/chat` on a
local self-host with a real data lake, real forced retrieval, the real `search_knowledge_base` tool and
the whole system-prompt stack - tells a harsher story on the same case and the same model:

| arm | `premise-challenge/asked-to-adjudicate` |
|---|---:|
| base-branch rule | **7 failures / 30** |
| word-list wording (see below) | 2 / 12 |
| shipped wording | **2 failures / 30** |

The five other cases that existed then were clean at 5 samples each on the shipped wording,
including both `mustAnswer` controls. Four of the ten cases in `cases.ts` have never been sampled:
`premise-challenge/invites-elaboration`, `grounded-answer/explain-supported-mechanism`,
`grounded-answer/correct-contradicted-claim` and `derive/asked-to-adjudicate`, all added afterwards.

**Every number in this section predates the supply class, and none of them is comparable to a run made
after it.** They were produced by a grader with three claim classes, which could not fail a reply that
named the gap and then supplied the absent fact - the failure the production measurement later found
in the arm this table calls "shipped wording". Treat them as the record of what the denial half
measured, and re-run BOTH arms before putting a post-change number beside them.

**Read the gap between the two harnesses as a warning about this eval, not about the stack.** The
minimal harness scored the shipped rule perfect while the real one still fails it 1 turn in 15. A
green run here is a floor, not a ceiling: the production prompt carries a register-shaped corpus AND
tool-result framing AND ~600 tokens of other system prompt, and the failure needs that weight to
appear reliably. If you are changing this rule, measure on the stack as well as here.

**The two survivors are hedged, and the grader is strict on purpose.** They read "would be inaccurate
according to your official documentation" rather than the base arm's flat "No, that is not accurate."
`grade.ts` fails both, because absence establishes that a claim is unattested and never that it is
wrong - and the grader was NOT relaxed to improve this number, which would have been the easiest way
to make the table look finished.

**Why the wording is about the act rather than the words.** The first version of this fix only
extended the ban list ("false, fabricated, invented, made up"). On the minimal harness it scored 0
failures in 12; on the full stack the model answered "**No, it is not accurate to say** Meridian Foods
saw a 40% faster dispatch cycle", reaching the verdict with none of the banned words. That is the
original defect's flaw one level down - an enumeration is only as wide as the paraphrases someone
thought of - so the shipped wording forbids answering the yes/no at all, says which speech act IS
allowed ("unsupported, uncited, not approved for external use"), and adds the sentence that addresses
what the failing replies actually reasoned from: a register or approved list bounds what you may cite,
not what happened.

**The defect is model-specific, so a green run is not by itself evidence.** `gpt-4o` never produced it,
on any arm. If you run this and see all green, check whether your model exhibits the failure on the
BASE-branch rule first - an eval against a model that never had the failure measures nothing.
`groundedSystemPrompt` takes the rule text as an argument precisely so you can run that arm.

Sampling is what makes these readable: the same case and model scored 3 failures in 12 and then 7 in
30 on the base rule. A single sample would have called it either way.

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

The supply class (`suppliedTheClaim`) is read by `gradeMustNotDenyPremise` alone, on two signals: a **percentage** appearing in neither the fixture corpus nor the user's own question, and a **general-knowledge frame** ("published benchmarks show", "gains like that are typically ..."). `gradeMustAnswer` stays blind to it by construction - a derived figure and a corrected one are both specifics the closed-world check cannot license, so reading it there would fail `grounded-answer/correct-contradicted-claim` - whose whole wanted answer
is the corrected 18% the asserted question never licenses - for doing the right thing. The two derive
cases carry no percent sign at all, so the percentage scan never sees them.

It is narrow on purpose, and the narrowings cost reach. Only percentages are scanned, so a fabricated dollar value or duration is not caught. The allowlist is every number the corpus states rather than only its percentages, so quoting "15 to 20%" does not read as inventing the 15 - but it is a **flat** set with no link back to the section a number came from, so an invented percentage colliding with any number anywhere in the corpus is licensed (25, 400 and 2024 all escape). The frame signal is suppressed inside a gap-naming sentence, and - BOTH halves of it - wherever a negation governs the supply, meaning it stands earlier in the same clause with no comma between ("I will not answer from general knowledge" names the same words as the supply it declines, and so does "I cannot say what typically drives gains like that"). A negation that reaches back over the source instead ("published benchmarks show gains of that size are not unusual") or is cut off from it by a comma is a hedge in front of a supply, and does not suppress. Its generalisation half ("typically", "usually") needs, besides a result noun, a DEMONSTRATIVE pointing back at the absent result - "gains of that size", "rollouts like that". That is a structural test rather than a vocabulary one on purpose: `result`, `reduction`, `improvement` and `baseline` are corpus text and `measured against` and `validated` are the case question's own verbs, so no word list separates the supply from the pointer the rule licenses, which is written in the same words. Each of those costs reach: a supply riding in the same sentence as the gap report, or generalising about the absent result without a demonstrative, escapes. **A purely qualitative supply carrying neither signal grades clean**, and two of the four measured turns were that shape. Reaching those needs a semantic check of whether an assertion is corpus-backed, which no pattern does.

Denials are detected per sentence, and a denial the same sentence disclaims ("that does not mean it did not happen") does not count - the wanted answer reaches for the same words the defect does, one sentence later and negated.
