# Desktop chat credit usage: findings

Scope: Code-mode turns on GPT-5.6 Sol through POST /api/ai/v1/completions. Prices from
`modelPrices.seed.json`: Sol <=272K prompt $5 in / $30 out per M, >272K $10 / $45; cache read 0.1x;
cache write 1.25x (GPT-5.6 and later, per OpenAI's prompt-caching guide).

## Root cause of the per-turn cache miss (fixed)

The live tool loop sends each round as an assistant turn plus a tool-result turn. When the reply
was stored, the next turn rebuilt it (`toCompletionMessages`) as ONE assistant message (all round
text joined, the last round's reasoning, every tool_use) plus ONE tool-result message. Provider
prefix caching breaks at the first differing token, so the hit stopped at the end of the previous
user message and everything the reply added (about 67.5K tokens in the traced session) was re-sent
as new input at the start of every turn.

Fix: replay `message.rounds` one by one through the same `roundWireMessages` the live loop uses, with
round text trimmed the way it is stored. Test: `ChatService.prefix.test.ts` (fails before: next
turn's request had 5 messages against 8 for the previous one; passes after: byte-prefix extension).

Residual divergences, all rare, deliberately left: replies with artifacts and replies stored before
rounds were kept still replay flattened; the ephemeral plan nudge on a tool result and screenshot
turns are live-only; Anthropic keeps only the last tool round's thinking blocks.

Estimated effect on the traced turn 3 (request, not measured live): round 1 would read about 199K
from cache and write about 2K instead of reading 134K and writing 67.5K. At the corrected prices:
before about $0.49 (new at 1.25x), after about $0.13 for that round; the turn goes from about $0.64
billed to about $0.35 (-46%), and from about $0.85 true provider cost to about $0.35.

## Part 1: billing correctness

| Item                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round and reply credit math  | Correct for the inputs it was given (verified separately).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| a) cache writes              | INCORRECT, fixed. OpenAI reports `cache_write_tokens` inside the prompt count (chat: `prompt_tokens_details`, Responses: `input_tokens_details`) and bills them at 1.25x from GPT-5.6. The adapter never read the field, so those tokens settled at 1.0x. Now split into disjoint new / read / write and priced by the existing default multipliers (6.25/M for Sol, no seed change). Docs state the write count is a subset of the prompt count; confirm against a live usage payload. |
| b) tier basis                | INCORRECT, fixed. `getTextModelCost` chose the tier from uncached `inputTokens`; the reservation estimate already used the whole prompt. A 300K prompt of 290K reads billed at $5/$30 instead of $10/$45. Tier now comes from input + read + write. Same rule holds for Anthropic (cache tokens count toward the 200K threshold). Gemini does not forward cache reads, so is unaffected.                                                                                                |
| c) reservation vs settlement | Correct on the success path: one reservation, one stochastic draw shared by the final event and the ledger, difference refunded or charged. GAP: a failed or aborted stream refunds the whole reservation and records `creditsCharged: 0`, though the provider bills the prompt it read. A user pressing Stop pays nothing for that round. Not changed; see follow-ups.                                                                                                                 |
| d) tooltip / reply / balance | Per-reply credits are the sum of per-round `creditsUsed` (840+227+209), and the usage event carries cogsUsd = `costUsd`, `creditsCharged`, read and write tokens. Reading the code, balance delta equals credits charged. Not checked against a live ledger row.                                                                                                                                                                                                                        |

## Part 2: cost levers, ranked

Static prefix measured with the real builders (4 chars per token estimate): system prompt about
3.3K tokens, 34 tool schemas about 7.9K tokens, so about 11K before project instructions and skills.
The 134K first-round prompt is conversation content (file reads, tool output), not fixed overhead.

1. Cache-prefix fix (done): about -46% on a small request in a long session, and it recurs every turn.
2. Cache lifetime: GPT-5.6 allows only `prompt_cache_options.ttl = "30m"` (the default; `24h`
   `prompt_cache_retention` does not apply). Any pause over 30 minutes re-writes the whole context at
   1.25x: a 134K prompt is about $0.84, not the $0.67 billed before write billing. Options: warn
   "cache expired, next turn costs about X"; compact before resuming an old session; evaluate
   `prewarm`. `prompt_cache_key` is optional on 5.6 and is for isolation, not routing.
3. The 272K cliff: crossing it doubles input, cache read and output rates for the WHOLE prompt (read
   goes $0.50 to $1.00 per M). Manual compaction is the only trigger today and the UI hints at 360K,
   which is past the cliff. Recommend a model-aware compact hint at the first tier boundary minus
   margin. With the tier fix this cost is now actually billed.
4. Per-round cache reads: about $0.10 per round at 200K. A 20-round turn at 200K is about $2 in
   reads alone, so batching tool calls and avoiding re-reads is worth more than trimming output.
   Context pruning's economics (write 1.25x, read 0.1x) are accurate for GPT-5.6; pruning cleared
   nothing in the traced session because its 40K-char floor was never reached.
5. Output: single rounds of 3K-5K output tokens cost $0.09-$0.15 each at $30/M; lower reasoning
   effort on mechanical turns. Sol to Terra is half price per token ($2.50/$15 here).
6. Show cost: running session total and a pre-send estimate once the cache is known cold.

No before/after live run was made (no spend); numbers above for the fix are computed from stored
per-round usage and the price seed.

## Follow-ups (not implemented)

- Settle partial usage on failed or aborted streams instead of refunding in full.
- Pre-send "cache expired" estimate and compact-before-resume prompt.
- Model-aware compaction hint below the first pricing tier.
- Persist screenshot turns and the plan nudge so they replay byte-identically.
- Store per-round thinking for Anthropic so earlier rounds replay with their thinking blocks.
- Evaluate `prompt_cache_options` explicit mode and `prewarm` for GPT-5.6.
