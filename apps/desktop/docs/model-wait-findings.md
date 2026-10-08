# Why a turn sits on "Waiting for the model..." - findings

Investigation of the long silent waits in desktop turns. This is a diagnosis, not a fix: the only
code on this branch is timing instrumentation behind two flags (see the last section).

## Summary

The waits of more than a minute are **the model writing output that the completions stream does not
carry**. Our own code adds tens of milliseconds, and neither prefill nor cache misses explain them.
Two kinds of hidden output cover every wait over 45s in the stored history:

1. **Tool-call arguments** (the biggest cause). A `file_write`, a `bash_execute` heredoc or a
   `session_spawn` prompt is thousands of output tokens. Both providers stream those arguments as
   they are generated, but the adapters drop the deltas and emit one `tool_use` frame once the call
   is complete. At 60-125 output tok/s, 2-6k tokens of arguments is 20-100s of total silence.
   Anthropic also buffers tool input server-side unless the tool sets `eager_input_streaming`.
2. **Reasoning that is never shown**. For GPT we never request reasoning summaries, and the
   Responses loop ignores them. For Claude, the `thinking` option the desktop sends is stripped
   by the request schema, so Opus 5 thinks at its default with `display` omitted. Every thinking
   block then streams as a bare `<think>`...`</think>` with no text. On GPT-5, hidden reasoning
   tokens correlate 0.87 with time to first text.

Every hypothesised cause on our side measured at or near zero: server pre-provider work (p50 2 ms),
SSE buffering (p50 1 ms) and desktop pre-send work (p50 70 ms). Prefill costs about 1.1s per 100k
uncached tokens on Opus 5 and less on GPT-5.5. A cache miss is a few seconds at most, never a
minute. Silent provider retries are real but rare (one `overloaded_error` surfaced after 18.6s of
silent retries in 208 logged requests).

Separately, a defect: **a session's reasoning effort never reaches Anthropic**. An Opus 5 session
set to `low` runs at the API default (`high`), which means more silent thinking.

## Data and method

- **Stored history.** I streamed every session file one at a time from three local desktop
  profiles: 186 sessions, 2026-09-30 to 2026-10-08. They hold 831 model rounds with
  `timing` + `usage`, in 132 turns. TTFT is `firstTokenAt - startedAt` per round.
  - **Selection bias:** only replies that ran tools or carried reasoning keep `rounds`. The 221
    plain replies store no timing.
  - **Model attribution:** each round is attributed to the session's current model, because
    mid-session model switches are not recorded.
  - **Claude lower bound:** `firstTokenAt` is stamped by the empty `<think>` marker, so for a
    Claude round that thought, the stored TTFT is a lower bound on the silence.
- **Self-host completions logs.** The shared container's existing `docker logs -t` hold 208
  requests since its last start. Each request has these log lines: authenticated, completion
  started, Anthropic request sent (the payload-diagnostics line) and finished.
  - 150 of them were joined to desktop rounds by timestamp.
  - The container was only read, never restarted.
- **Probes through our own server path.** The local env holds no provider keys; the stack reads
  them from its database, so a direct-to-provider comparison was not possible as specified.
  - I ran my own completions instance from this branch with server timing on, on a free port.
    I sent it desktop-shaped requests (same body: `toolSchema` envelope, `thinking: {enabled:
true}`, `reasoningEffort`) and timestamped every SSE frame on arrival.
  - Two of the runs used a temporary, uncommitted adapter patch to measure what the proposed fixes
    would change.
  - 13 billed provider calls, **$1.87 total** (most of it one 144k-token Opus cache write). The
    instance was torn down afterwards.

## Time to first token in the stored history

| Slice             | n   | p50  | p75   | p90   | p95   | max    | >20s | >45s | >60s |
| ----------------- | --- | ---- | ----- | ----- | ----- | ------ | ---- | ---- | ---- |
| all rounds        | 831 | 3.2s | 5.0s  | 10.5s | 17.0s | 103.2s | 35   | 7    | 2    |
| claude-opus-5     | 385 | 3.2s | 4.1s  | 6.0s  | 9.4s  | 75.2s  | 8    | 2    | 1    |
| gpt-5             | 225 | 5.3s | 10.9s | 21.3s | 32.8s | 103.2s | 25   | 5    | 1    |
| gpt-5.5           | 111 | 3.0s | 4.0s  | 7.2s  | 9.2s  | 39.9s  | 1    | 0    | 0    |
| gpt-5.6-sol       | 104 | 2.6s | 4.0s  | 5.6s  | 6.6s  | 22.4s  | 1    | 0    | 0    |
| claude-sonnet-4-5 | 6   | 1.5s |       |       |       | 1.6s   | 0    | 0    | 0    |

`claude-haiku-4-5` and `gpt-5.4-mini` have no timed rounds in the stored data.

Seen per turn, as the stall line would see it, 7 of 132 timed turns (5.3%) had a round silent for
over 45s before its first frame. Adding the arguments written after a round's visible text (see
H6), an estimated 10 of 128 turns (7.8%) went silent for over 45s somewhere, and 4 for over a
minute.

### What it correlates with

- **Output tokens: strongly.** corr(TTFT, output tokens) is 0.86 on gpt-5 and 0.77 on gpt-5.5.
  - **Tool-only rounds:** a round that only calls a tool has no text to show, so its first frame
    is the finished call. Those rounds give 0.93 on gpt-5, at a steady 64 output tok/s (p25-p75
    52-82). A decode-time model at that rate leaves a residual of p50 0.0s and p90 5.3s.
  - **Rounds with text:** the residual is hidden reasoning. corr(TTFT, output tokens not
    accounted for by text or arguments) is 0.87 on gpt-5 and 0.93 on gpt-5.5.
- **Round kind.** Every one of the 7 rounds over 45s carried a tool call, and 6 of them called
  nothing else.
  - The tools were `bash_execute` (5: long heredocs and scripts) and `session_spawn` (2: long
    prompts), with 2.8k-6.2k output tokens.
  - Over 20s, 19 of 35 rounds were tool-only. The commonest tools were `bash_execute`,
    `file_write`, `session_spawn` and `apply_patch`.
- **Prompt size and cache: barely.**
  - corr(TTFT, uncached input) is 0.03 on Opus 5, 0.02 on gpt-5, 0.04 on gpt-5.5 and 0.17 on Sol.
  - Opus rounds with 200k+ uncached tokens: p50 4.3s, max 8.3s (n=8).
  - Opus rounds under 10% cache hit: p50 3.9s (n=20), against 3.2s for rounds over 90% (n=306).
    That is about 0.7s.
- **First round of a turn vs later.**
  - Claude: p50 3.1s vs 3.2s, the same.
  - GPT: round 0 is slower, p50 5.4s and p90 28.2s against p50 3.0s and p90 11.9s. A turn's
    first round is where GPT plans, and it plans silently.
- **Idle gap before the turn (reopening a conversation).** Claude round 0 drifts from p50 2.6s
  (<1 min idle) to 3.9s (5-60 min) and 4.3s (1-24h, max 5.9s), consistent with the provider cache expiring. It is
  worth a second or two. GPT shows no trend.
- **After a compaction.** Only 2 such rounds were timed (1.6s and 1.8s), which is too few to
  conclude anything.
- **Reasoning effort.** Opus 5 `low` (p50 3.3s, p90 6.0s) and `default` (p50 3.0s, p90 5.9s)
  are indistinguishable. That is what you would expect if the setting never arrives (see H1).

## Hypotheses

### H1. Silent reasoning - CONFIRMED, second cause

- **The desktop.** It sends `options.thinking: {enabled: true}` and `reasoningEffort`.
  - `CompletionRequestSchema.options` (`b4m-core/common/src/schemas/cliCompletions.ts`) does not
    declare `thinking`, so zod strips it.
  - `executeCompletion` has no field for it either.
  - Both Anthropic adapters build `thinking` and `output_config.effort` only inside
    `if (options.thinking?.enabled)`. Effort is read only in there too.
  - **Evidence:** all 57 Anthropic requests in the container logs went out `hasThinking: false`.
- **Claude.** Opus 5 thinks adaptively anyway (on by default), with `display` defaulting to
  `omitted`. The adapter forwards each thinking block as `<think>`, empty deltas, then `</think>`.
  - So a frame arrives at about 1.5s and then nothing readable does.
  - **Probe** (Opus 5, a reasoning question, today's request shape): marker at 1.45s, no readable
    reasoning frames, text at 5.41s, longest silence 3.96s.
  - **Same probe with `display: "summarized"`:** readable reasoning at 4.77s, longest silence
    2.38s.
- **GPT.**
  - The Responses loop (`openaiBackend.ts`, `completeViaResponses`) forwards only
    `response.output_text.delta`. It requests no `reasoning.summary`, and its comment marks
    summary events as "intentionally ignored".
  - `gpt-5.5` and the `gpt-5.4` family are not in `RESPONSES_API_TOOL_MODELS`. They go through
    Chat Completions, which never exposes reasoning.
  - **Probe** (Sol, with `summary: 'auto'` patched in): a reasoning item opened at 1.15s and
    summary deltas began at 3.0s, against first text at 4.8s. A "Thinking..." line could start
    within about 3s.
- **What feat/desktop-quality covers.** It reads Claude's reasoning only from the `thinking`
  blocks on the finished `tool_use` frame (`readableThinking`), after the round. It covers nothing
  for GPT, and its "Thinking..." state needs readable `reasoning` text that, per the above, never
  arrives.
- **Wait explained.**
  - Opus 5 at today's settings: 2-4s of thinking before visible text in the probes.
  - gpt-5: p50 422 and p90 1,891 hidden tokens in text rounds, which is about 7s and 30s at 64
    tok/s.
  - In the slow tool rounds, gpt-5 spent 1.1k-5.1k hidden tokens (17-80s) before writing the
    arguments.
  - So it is the second-largest share of the over-a-minute waits, and the whole of the 40-50s
    waits before a text answer on gpt-5.

### H2. Prefill of a large uncached prompt - RULED OUT as a cause of long waits

- **Probes, cold vs warm on the same prompt:**
  - Opus 5 with 144k tokens: 6.17s cold (cache write) vs 4.58s warm (cache read), so +1.6s, or
    about 1.1s per 100k uncached tokens.
  - GPT-5.5 with 85k tokens: 2.00s vs 1.72s, so +0.3s.
- **History:** the largest uncached Opus rounds (200k+) peaked at 8.3s.
- **Wait explained:** at most about 2s on the largest resumed turns.

### H3. Server overhead before the provider call - RULED OUT

- **Container logs (Anthropic requests):**
  - Auth to completion start: p50 7 ms, p90 13 ms.
  - Completion start to request sent: p50 2 ms, p99 27 ms, max 33 ms. That covers keys,
    settings, the model catalog, credit reservation and the concurrency semaphore.
  - The desktop round start to the server's auth line was p50 19 ms (p90 44 ms) over 150
    joined rounds.
  - Of a round's TTFT, p50 2% (p90 5%) was spent before the request left our server.
- **My instance:** the request reached the provider 9-36 ms after it was received.
- **Edge case:** a cold model-catalog cache costs up to about 10s on a miss, by code reading. It
  never showed in the logs (5-minute TTL).
- **Wait explained:** about 0s.

### H4. Provider queueing, rate limits, retries - CONFIRMED but rare

- **Retries compound and are silent.** The Anthropic SDK is constructed with `maxRetries: 5`, a
  transport-retry fetch (2) and an outer `withRetry` (3).
- **One case in the logs:** an `overloaded_error` reached the client 18.6s after the request was
  sent, with nothing on the stream meanwhile but 10s keep-alive comments the desktop does not
  surface.
- **Not counted:** SDK retries are not logged at all, so their frequency cannot be read from the
  logs. One failure in 208 requests is a floor.
- **Other gaps:**
  - The route does not pass an abort signal, so a desktop that gives up leaves the retries
    running.
  - The Anthropic semaphore (15 per process) was never at capacity.
- **Wait explained:** 0 in the typical case. About 20s, and by code reading up to minutes, when a
  provider is overloaded.

### H5. Desktop work before the request - RULED OUT for the model wait

- **User message stored to round 0 sent:** p50 70 ms, p90 2.0s, p99 3.3s (132 turns).
  - One outlier of 37s could not be attributed. It could be an MCP server connect (each has a
    30s timeout in `McpManager`) or a message queued behind a running turn.
- **Auto-compaction** runs before the user message is stored and shows its own "compacting"
  status, so it is never the "Waiting for the model" line.
- **Title and next-prompt requests** run concurrently or after the turn.
- **Wait explained:** about 0s typically. Up to 30s in the MCP case, which shows as waiting even
  though the model has not been asked yet.

### H6. Streaming buffering - RULED OUT, and the main cause found in its place

- **Not buffering.**
  - The server's finish log line and the desktop round end agree to p50 1 ms (p90 5 ms).
  - In the probes the desktop saw each frame within about 30 ms of the server writing it.
  - There is no compression middleware, and `no-transform` is set.
- **But the frames are withheld at the adapter.** The tokens exist and are not held back by a
  proxy; the adapter never turns them into frames.
  - **Anthropic, eager input streaming patched on:** `input_json_delta` arrived from 7.0s to 48s
    at about 16 deltas/s, while the desktop saw no frame from 7.0s to the `tool_use` at 48.4s.
  - **Sol:** `function_call_arguments.delta` arrived from 2.1s to 18.0s (about 120 deltas/s)
    while the desktop saw 18.2s of silence.
  - **Today's shape, about a 220-line `file_write`:** 39.8s of silence on Opus 5 (4.3k output
    tokens) and 27.0s on Sol (2.5k).
- **Within a round.** In a round that writes text and then calls a tool, the arguments go silent
  again after the text, which the stored TTFT cannot see. Estimated as argument tokens divided by
  the decode rate, that adds 3 more rounds over 45s, 2 of them over a minute.
- **Wait explained:** the largest share. All rounds over a minute in the history are tool rounds.

## Ranked causes of the over-a-minute waits

| Rank | Cause                                                                    | Share of >60s silences                                                        | Typical size                                       |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| 1    | Tool-call arguments written silently (H6)                                | 4 of 4 rounds; dominant in each                                               | 1-4k tokens = 15-60s on Opus/Sol, 15-100s on gpt-5 |
| 2    | Reasoning never shown (H1)                                               | inside the same rounds, before the arguments; 1.1-5.1k hidden tokens on gpt-5 | 2-7s on Opus/Sol, 7-80s on gpt-5                   |
| 3    | Silent retries on an overloaded provider (H4)                            | 0 of the timed rounds; 1 failed turn in the logs                              | ~20s, more by code reading                         |
| 4    | Effort ignored on Anthropic (H1)                                         | magnifies 2 on every Opus session set below `high`                            | not measured                                       |
| -    | Prefill / cache miss (H2)                                                | 0                                                                             | +1.1s per 100k uncached tokens                     |
| -    | Server pre-provider work (H3), SSE buffering (H6), desktop pre-send (H5) | 0                                                                             | tens of ms                                         |

## Proposed fixes

1. **Forward tool-argument progress.** Expected impact: removes the over-a-minute silences
   outright. A round's longest silence falls to the reasoning before the call (2-7s on current
   models).
   - **Anthropic adapter:**
     - Set `eager_input_streaming: true` on client tools in the streaming path.
     - On `content_block_start` (tool_use), emit a progress callback with the tool name.
     - Emit throttled progress callbacks on `input_json_delta`, carrying bytes so far.
   - **OpenAI adapters:** do the same from `response.output_item.added` (function_call) and
     `response.function_call_arguments.delta` on Responses, and from tool-call deltas on Chat
     Completions.
   - **Wire:** carry it as a new frame type, e.g. `{type: 'tool_progress', name, chars}`, at most
     a few per second. The desktop's `parseStreamEvent` already skips unknown frames, so older
     clients are unaffected.
   - **Desktop:** show "Writing `file_write` arguments... 12 KB".
2. **Show reasoning.**
   - **Anthropic:** add `thinking` to `CompletionRequestSchema.options` and `CompletionParams`,
     and send `thinking: {type: 'adaptive', display: 'summarized'}`. `display` changes visibility
     only, not billing. Expected impact: readable reasoning within about 2-5s of the request on
     Opus 5. The probe's longest silence went from 4.0s to 2.4s.
   - **GPT:** request `reasoning.summary: 'auto'` on the Responses path and forward
     `response.reasoning_summary_text.delta` as `<think>` text, which the desktop's `thinkFilter`
     already understands. Move `gpt-5.5` / `gpt-5.4` tool turns to Responses so they get it too.
     Expected impact: a visible "Thinking..." from about 3s instead of up to 80s of nothing on
     gpt-5.
3. **Make reasoning effort reach Anthropic.** The same schema change as fix 2 lets
   `resolveAnthropicEffort` run, so `output_config.effort` is sent. Expected impact: Opus sessions
   set to `low` or `medium` actually think less, so they are shorter and cheaper. Not measured.
4. **Status line: tell "thinking" from "writing" from "stuck".** The stall line in
   feat/desktop-quality resets on any frame and shows the same text whether the model is thinking
   or the connection is dead. With the frame kinds the probe already classifies, it can show:
   - **Thinking...** from a `<think>` marker until `</think>`, even with no readable text (Opus
     today), with elapsed time.
   - **Writing _tool_... N KB** while tool progress frames arrive (fix 1).
   - **Waiting for the model...** only when no frame of any kind has arrived, the keep-alive
     comments are still coming, and the request is past the threshold.
   - **Connection stalled** when even the server's 10s keep-alive comments stop.
     `eventsource-parser` exposes them through `onComment`, so `completions.ts` can stamp them
     without them reaching the reply.
   - With fixes 1 and 2 in place, the 45s threshold can come down, because a working model no
     longer looks idle.
5. **Make retries visible and bounded.**
   - Emit a `meta` frame when an adapter retries, with the attempt number and reason, so the line
     can say "Provider busy, retrying (2/5)...".
   - Pass the request's abort signal from `sseRoute` into `executeCompletion`, so a disconnected
     client stops the retries.
   - Pick one retry layer for Anthropic instead of 5 x 3 compounding.
   - Expected impact: no change in time, but the 20s+ overloaded waits become legible.
6. **Keep enough timing to answer this next time.** Store the probe's phases on `ChatRoundTiming`:
   first visible text, first tool call, and the longest gap with its cause. Store a timing for
   plain replies too. The 221 plain replies in this data set have none, which is the main blind
   spot here. The cost is a few numbers per round.
7. **Land fix/desktop-cache-prefix-stability for cost, not latency.** See below.

## What landing fix/desktop-cache-prefix-stability would change

The branch makes the stored-reply replay byte-identical to what the live loop sent. Each next turn
then reads the previous reply from cache instead of re-sending it as new input; its doc traces
about 67.5k tokens per turn in one session.

- **Cost:** about -46% on the traced turn, per its own doc. That is real.
- **Latency:** at the measured prefill cost of about 1.1s per 100k uncached tokens on Opus 5
  (less on GPT), it saves about 0.7s on such a turn. The history agrees: low-hit Opus rounds are
  only 0.7s slower at p50 than high-hit ones.

It does not touch the over-a-minute waits, which are output-bound, not input-bound.

## What I could not measure, and why

- **A direct provider comparison as specified.** The local env files hold no provider keys; the
  stack resolves them from its database, and I did not extract them. Instead, every probe went
  through my own instance of our server path. The server-side marks show our own overhead is
  10-40 ms, so those probes are effectively provider timings.
- **Provider queueing vs model time.** Our logs mark the request leaving, not the provider's
  first byte. The probes put an upper bound on queue plus prefill for small prompts at the first
  marker or reasoning item: 1.15-2.4s.
- **SDK retry frequency.** The SDKs retry without logging. One surfaced failure is a floor, not a
  rate.
- **Plain replies** (221 of them) store no timing, and Claude rounds that thought have a TTFT
  stamped at the empty marker. The history therefore undercounts silence for both. Plain-reply
  wall time (send to settle) reaches 60s+ in 15 Claude replies, but cannot be split into silence
  and streaming.
- **Per-round model.** Rounds are attributed to the session's current model. A session switched
  mid-way is misattributed.
- **The hosted path.** The hosted path (538 stored rounds) was covered only through the stored
  history; it has no server logs here and no probe. Its distribution is close to self-host (p50
  3.4s vs 2.8s, p95 13.8s vs 26.9s), and the cause analysis above is path-independent.
- **The effect of fix 3 (effort).** I did not run Opus at `low` vs `high` effort side by side.
- **Not verified, noticed in passing.** `buildSSEEvent` takes `text[1] || text[0]` from an
  adapter's index-keyed chunk array. A content block at index 2 or later (for example text after
  a second thinking block) may never reach the wire. It is worth a test.

## Instrumentation on this branch

Both are off by default. When a flag is off, the round loop and the route pay one null check per
frame: no per-token allocation, no per-render work.

- **Desktop: `B4M_DESKTOP_TURN_TIMING=1`** (`apps/desktop/src/main/chat/turnTiming.ts`,
  `createRoundProbe`). Per round it records:
  - desktop work before the request (first round)
  - the first meta, `<think>` marker, readable reasoning, text and `tool_use` frames
  - the longest silence and what ended it

  It publishes these to the developer log under the `chat-stream` tag, and to the debug log as a
  `CHAT_TIMING` line when `B4M_DESKTOP_VERBOSE=1`.

- **Server: `B4M_COMPLETION_TIMING=1`**
  (`apps/client/server/chatCompletion/external/completionTiming.ts`). It records the auth,
  rate-limit and completion-start marks, the first chunk of each kind (classified by the
  adapter's reasoning channel), the longest gap and what ended it. It logs one `[CLI_TIMING]`
  info line per request.

Landing these is a separate decision from the fixes above. The server line is cheap enough to
leave on in production: one object per request, logged once. That would make the next
investigation of this a `grep`.
