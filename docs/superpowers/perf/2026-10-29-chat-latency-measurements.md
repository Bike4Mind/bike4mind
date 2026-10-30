# Chat latency batch: measurements

Protocol (from `docs/superpowers/specs/2026-10-29-chat-latency-batch-design.md`):

- Benchmarks live next to the code as vitest files gated by `B4M_PERF=1`, so CI skips them.
- Each prints a before/after pair: A/B inside one run where the old path can be reproduced
  in-process; otherwise the same file is run at the baseline commit and at head.
- Numbers below are copied from the benchmark output on a developer Mac (Node 24, jsdom,
  `VITEST_MAX_WORKERS=1`). Treat them as relative, not absolute.
- End-to-end TTFT is validated on a preview deploy through the existing e2e `ai-latency`
  suites, not here.

| Item | Metric | Before | After | How measured |
|---|---|---|---|---|
| 1. Frozen-prefix streaming markdown | Render time for a 6.7 KB reply streamed in 60 frames: total ms; per-frame p50/max ms | 295.9 total; 4.8 / 11.3 | 227.0 total; 3.5 / 10.6 (committed half as one parse); 46-57 total after the regression passes (one parse per settled block, see below) | `B4M_PERF=1 VITEST_MAX_WORKERS=1 pnpm --filter @bike4mind/client exec vitest run app/components/Session/markdown/StreamingMarkdown.perf.test.tsx --reporter=verbose`; A = `ReactMarkdown` on the full prefix every frame, B = `StreamingMarkdown streaming`, same plugins (assistant remark plugins + rehype-katex) and plain `code` component |
| 2. Reasoning text renders as it arrives | 20 frames 100 ms apart, real timers: commits; ms until the last frame's full text is in the DOM | 164 commits; 3981.0 ms | 20 commits; 1940.9 ms | `B4M_PERF=1 VITEST_MAX_WORKERS=1 pnpm --filter @bike4mind/client exec vitest run app/components/Session/ThoughtBubbles.perf.test.tsx --reporter=verbose`; A = inline copy of the old `useAnimatedText` (2 s framer-motion animation), B = text rendered directly; B's 1940.9 ms is the 19 x 100 ms stream itself |
| 3. Keep-alive dispatcher for provider SDK clients | 4 sequential GETs to api.anthropic.com/v1/models, 5 s idle gaps (401 is fine): new TCP+TLS connects; per-call ms | 4 connects; 297.9, 236.8, 233.2, 231.9 | 1 connect; 320.4, 168.1, 204.0, 192.4 | `B4M_PERF=1 VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/llm-adapters exec vitest run src/providerDispatcher.perf.test.ts --reporter=verbose`; A = Node's global dispatcher, B = `providerDispatcher()`; connects counted on `undici:client:connected`; the first B call pays the handshake, calls 2-4 reuse it |
| 4. Bounded pre-token retry budget | Sustained 529 on a streaming Anthropic call, fake clock: HTTP attempts; total ms until the error surfaces | 24 attempts (6 SDK x 4 app); 60441 ms | 6 attempts (3 SDK x 2 app); 3209 ms | `VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/llm-adapters exec vitest run src/retryBudget.perf.test.ts --reporter=verbose`; not gated (fake timers); before = same test at the old values (SDK `maxRetries` 5, app `withRetry` 3) |
| 5. Frame seq + static-field dedupe | 200 streamed frames, reply growing 10 chars per frame, 1 KB `prompt`, `promptMeta.citables` serialising to 20 KB: total bytes handed to `sendToClient` | 4528200 bytes | 276658 bytes (16.4x fewer); 468952 bytes (9.7x fewer) after the regression pass, which repeats the static set every 20 frames | `B4M_PERF=1 VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/services exec vitest run src/llm/StatusManager.perf.test.ts --reporter=verbose`; A = a fresh `StatusManager` per frame (no record of sent statics, so every frame carries them, as before), B = one manager for the stream; both include the new `seq`/`streamId` envelope |
| 6a. Token breakdown estimates | 40 messages / 40078 cl100k tokens, real `TiktokenTokenizer`: median ms of 15 runs for the six `calculateTotalTokenLength` calls | 55.7 ms (six exact) | reverted: 55.7 ms (six exact) | Shipped briefly as one exact count plus six char estimates scaled onto the exact total (27.7 ms), then reverted in the regression pass: on mixed content (prose system prompt plus a code or CJK file) the per-source buckets were off by 20-50% and the whole error landed in `systemPrompts`, which the admin Context Inspector, the telemetry recommendations and the overflow error text all display. A 28 ms saving on a 40K-token turn did not justify that. |
| 6b. Overlapped preamble reads | Serial awaited Mongo round trips before the provider call | N | N-2 | Count, not timed: `apps/client/pages/api/ai/llm.ts` now overlaps `checkFreeTierDailySpendCap` with `admitRequestCompletion` (the admission check starts first, a spend-cap refusal returns at once without waiting for it, and otherwise the admission result is awaited, so the error precedence is the serial one); `ChatCompletionProcess` overlaps `loadModelConfigurations` with `loadFreeTierAllowedModels` (`loadModelAdmissionSettings`). Upper bound: the settings reads can hit the in-process settings cache and admission is a no-op for non-API-key callers, so the saving per turn is 0-2 round trips |
| 7. Downscale images to 2576 px before upload | Pixel budget for a 4000x3000 (12 MP) photo | 12.0 MP | 4.98 MP (2.4x fewer pixels) | Arithmetic from `planImageResize` (4000x3000 -> 2576x1932), asserted in `apps/client/app/utils/imageResizer.test.ts`. Policy change: resize threshold `>3 MB only -> any edge >2576 px` (the 3 MB rule still applies after it; GIF and SVG are left alone). The cap started at 1568 px and was raised in the regression pass: current Claude models read up to 2576 px, the server caps Claude/Gemini/Bedrock images at 2000 px anyway, and OpenAI used to get the original, so 1568 px lowered what every provider saw. WebP and AVIF now re-encode as WebP (PNG where the browser cannot encode WebP) instead of JPEG, which painted their transparency black. jsdom cannot encode canvases, so byte savings were not measured in a browser here. |

Notes on item 1: at 60 frames each frame adds ~110 bytes, which crosses a blank line on most
frames, so the committed half re-parses on most frames. Two repeat runs gave 291.5/221.2 and
293.2/212.3 ms (A/B total). A one-off run with the frame count set to 300 (~22 bytes per frame,
closer to a fast model's 100 ms frames) gave A 1245.2 ms total, p50/max 4.5/8.6 vs B 294.3 ms
total, p50/max 0.3/10.4. The B max is the frame where the committed half changes; it stays about
equal to A's full-parse cost.

Notes on item 2: re-run at head c5defb153; the A side (old animated text) commits a timing-dependent number of times, so 173 earlier became 164 and 3965.1 ms became 3981.0 ms. B is stable at 20 commits.

Notes on re-runs at head c5defb153: items 1, 3, 4, 5 and 6a reproduced within noise (item 1 A/B total 285.2/210.9 ms; item 3 connects 4/1; item 4 6 attempts, 2915 fake ms; item 5 bytes identical; item 6a 57.5/28.8 ms). Row values above are the original runs.

## Regression pass (2026-10-30)

Four fresh agents, one per area, were briefed to break the branch against the base commit
and left their tests in place as `*.regression.test.ts(x)` files (165 tests). What they
found, and what changed because of it:

| Area | Finding | Fix |
|---|---|---|
| Render | A block remounted when it moved from the live tail into the committed half, so a mid-stream "Load image" click was lost; a fence body line like "```js" was taken as a closer; loose lists split in two; code blocks in the tail got tail-relative `node.position` (different artifact id than after commit) | `StreamingMarkdown` renders one `ReactMarkdown` per settled block, keyed by block index, so the tail element becomes the next settled block without remounting; a remark plugin shifts each block's node lines back to reply-relative; the fence closer must be bare and indented at most 3 spaces; a blank line inside a list, or before a link/footnote definition, no longer ends a block |
| Transport | A per-connection send failure never rejects (`ClientMessageSender` settles all connections), so a lost static-carrying frame was never re-sent; the serialised send chain let one hung `PostToConnection` hold back the terminal frame; frames were built at delivery time, not at call time; the client lost prompt/citables/artifacts after a session switch or a foreign-quest frame | Frames are built synchronously at call time and delivered concurrently as before (seq still in call order); the full static set repeats every 20 frames (`STATIC_RESEND_EVERY_FRAMES`); the client remembers each quest's statics in `useStreamingQueryUpdates` and restores them on frames that omit them |
| Preamble | Estimated token buckets were off by 20-50% on mixed content; a spend-cap refusal waited for the admission read | Breakdown reverted to exact counts (row 6a); spend-cap refusal returns at once |
| Adapters / images | 1568 px was below what current Claude models (2576 px), the server cap (2000 px) and OpenAI (original) received before; transparent WebP/AVIF became black-background JPEG | Cap raised to 2576 px; WebP/AVIF re-encode as WebP (row 7) |

Verified clean by the agents (no change needed): retry classes and error surfacing per
provider, mid-stream errors never retried, keep-alive socket reuse and shutdown, no proxy
configured at base, authorization and billing outcomes identical across every spend-cap x
admission combination, per-quest dedupe isolation, final rendered markdown identical to base
on a 14-input corpus, ThoughtBubbles.

Known, accepted: reference links and footnotes render as raw text in an earlier block until
the reply completes (base showed them resolved only once the definition had streamed, so the
window is the definitions-to-completion gap); the stored chat attachment is the capped copy,
not the user's original; a sustained 429 gets 6 HTTP attempts instead of 24; the shared
dispatcher would bypass a `NODE_USE_ENV_PROXY` setting (not set anywhere today).

## Regression pass, round 2 (2026-10-30)

Four more fresh agents on the tree after round 1's fixes, briefed with round 1's findings and
accepted items so they would attack the new code (83 further tests kept as
`*.regression2.test.ts(x)`):

| Area | Finding | Fix |
|---|---|---|
| Render | Completion collapsed the keyed blocks into one parse, so every block after the first remounted at the end of each stream (approved images reverted, charts and maps re-initialised); the line-offset sum was quadratic in block count (slower than base above ~1000 blocks); CRLF replies defeated fence detection; a line of only U+00A0 counted as blank; gluing a footnote definition to its paragraph put the footnotes section mid-reply | A reply that streamed in this view keeps the block structure once complete unless the text holds a footnote, a link reference definition or an HTML block (then it is one parse, as a reply mounted complete always is); a newline text node between blocks matches the single parse's DOM; running-sum offsets; `\r` stripped before the line tests; CommonMark blank is spaces and tabs only; only link reference definitions are glued, footnote references stay raw until completion |
| Transport | The client's remembered statics were keyed by quest id only, so a retry reusing the id showed the previous run's citation chips, and entries for terminal frames seen from another session were never dropped; after a full frame failed outright, an identical next update was deduped away so the statics were not re-sent | Statics are keyed by quest id and `streamId`, the map is capped at 64 quests; a failed send also clears the last-sent payload |
| Images | A WebP over 2576 px on WebKit (Safari, every iOS browser) re-encoded as a PNG several times larger than an in-budget original | The original is kept when the re-encode is larger and the original is within 3 MB |
| Cross-cut | No regression. Noted: `storageQuota.ts` still models the old 3 MB rule for its pre-check (refuses what base refused, loses part of the new headroom); `.avif` is refused by the server so the AVIF branch is dead for chat attachments; on WebKit a WebP over 3 MB still goes through the legacy JPEG path with black alpha, as at base | Follow-ups |

Accepted after round 2: a static change carried by a frame that a later lean frame overtook
is dropped by the seq guard and shows up on the next full frame (up to 20 frames, about 2 s);
a quest left `running` by a crashed worker renders per block until timeout recovery flips it
(at most the 2 minute quest timeout).

## Regression pass, round 3 (2026-10-30), per pull request

The batch was split into five branches (one per area) and a fresh agent reviewed each as a
PR that must ship alone on top of main. Their suites stay in as `*.regression3.test.ts(x)`.

| PR | Finding | Fix |
|---|---|---|
| Render (`perf/chat-stream-render`) | The regex gate for cross-block constructs matched code (`[^a-z]`, `[key: string]:`, column-0 XML), so those replies still collapsed to one parse on completion and remounted; keeping blocks after completion made the splitter's heuristic divergences permanent (lazy list continuation lines, a fence or `$$` opened on a list-marker line, definitions nested in a blockquote or list item); the gate ran unmemoised on every re-render with quadratic backtracking | The splitter now parses the tail with the caller's remark plugins (`remark-parse` is already a client dependency) and settles whole top-level mdast nodes, so block boundaries are the parser's own; the cross-block flag comes from `definition` / `footnoteDefinition` nodes in the tree; settled blocks carry over between frames in component state, so only the tail is parsed and nothing runs per re-render. Reference links are no longer glued to the block before them (raw until completion, like footnotes). Render benchmark: 60 frames 297 ms (A) vs 101 ms (B); the extra parse of the tail costs about 50 ms over round 2's 55 ms |
| WebSocket frames (`perf/ws-frame-dedupe`) | With two concurrent runs of one quest (duplicate dispatch, a pre-existing hazard) and another quest's frame in between, the client's remembered statics were overwritten per quest and restored nothing | Statics are remembered per quest id and streamId, so interleaved runs keep their own |
| Images (`perf/image-upload-downscale`) | With real encoders, a PNG screenshot re-encodes 2.5-5x larger than the original, so the in-budget guard returned the original after two decodes and a full encode on the send path; a PNG over 3 MB went through the 2576 px render before the legacy loop; the decode bitmap leaked when `getContext` or `drawImage` failed | PNG keeps the size-only rule it had at base (no decode, no render); the bitmap is closed in `finally` |
| Preamble (`perf/chat-preamble-overlap`) | None | Ships alone |
| Provider transport (`perf/provider-keepalive-retries`) | None. Noted: the non-streaming Anthropic call keeps `withRetry` 3, so 12 attempts; a socket idle under 60 s can be stale after a NAT drop, and the transparent transport retry covers it | Ships alone |

## Regression pass, round 5 (2026-10-30), render PR only

No rendering difference found. Three missed settles in the re-parse trigger, all caught up by the
parse at completion: a list waiting for the next node's first line to end was not re-parsed when
that line ended; a list-marker line below a list was never a boundary even when another node
(a column-0 fence) had already ended the list, so numbered steps with fences settled late; a
skipped frame reported `crossBlock` without the unsettled tail. Fixed: the trigger remembers the
line a list waits on and re-parses once it ends; the same-marker exclusion only holds while no
other column-0 line has ended the list; a skipped frame keeps the last parse's `crossBlock`.
The never-settle tight-list benchmark ran at 1.07-1.15x base across runs (the splitter is about
1 ms of it), so its gate is 1.3x.

## Regression pass, round 6 (2026-10-30), render PR only

No rendering difference. Three more missed settles in the re-parse trigger, all from guessing
where a list ends with a regex: a line indented less than the item's content ended the list
without being seen; a lone `*` or `-` that later grew into `**bold**` or `---` kept its first
class; `- - -` under a `-` list counted as an item. Fixed by taking the list's facts from the
parse instead: the tail's list carries its start, marker and its last item's content indent
(from the first child's column); a line continues the list only as a further same-marker item
(thematic breaks excluded) or when indented to the content; an item still without content on
the tail's last line is a line the list waits on; the unterminated last line inside a list is
not classified at all, which keeps the count monotone (pinned by a fuzz over 500 texts x 5
chunkings). Never-settle shapes: loose list with code 210 vs 246 ms, long table 319 vs 314 ms,
tight list 276 vs 226 ms, one code block 30 vs 29 ms (A vs B, 60 frames).

## Browser A/B on the local host-dev stack (2026-10-29)

Same machine, same Docker backing services (Mongo, WS gateway, MinIO, SQS), same user and
model (gpt-5.6-terra, the session default), same 8 prompts in the same order, one fresh
notebook per prompt. Each variant ran `next dev` on :3000 and the chat-completion server
from source on :8789 (`B4M_SELF_HOST=true`), BEFORE from `main` (f8ccf5264), AFTER from this
branch (8a7fa9947). One uncounted warm-up turn per variant absorbed the dev-server route
compile. Machine load average was about 7.8 throughout (Docker VM and Spotlight indexing),
and the BEFORE run overlapped a read-only review agent; neither favours AFTER.

Browser probe (injected per page): time from Enter to the first character in
`ai-response-markdown` (TTFT as the user sees it), stream duration until the stop button
disappears, DOM mutations under `body`, and `PerformanceObserver` long tasks on the main
thread during the turn. Server numbers come from each quest's `promptMeta.performance` and
`turnTiming`.

| Metric (median of 8) | BEFORE | AFTER | Delta |
|---|---|---|---|
| Browser TTFT, ms | 3556 | 3106 | -13% |
| Server firstTokenTime, ms (process start to first token) | 3121 | 2670 | -14% |
| Server contextBuildMs | 102 | 108 | ~0 |
| Stream duration, ms | 6085 | 5446 | -11% |
| Long tasks per turn | 6 | 5 | -9% |
| Long task total, ms | 724 | 672 | -7% |
| Longest task, ms | 277 | 238 | -14% |
| DOM mutations per turn | 274 | 297 | +9% |

Per-prompt TTFT (BEFORE / AFTER, ms): P1 3956/3261, P2 4734/4902, P3 2371/3671,
P4 1840/2950, P5 5243/2243, P6 1913/2025, P7 3155/2947, P8 8651/4337.

Reading: TTFT is dominated by the provider (1.3 s to 8 s on identical prompts), so the
13-14% median gain is inside provider noise and should not be quoted as a win; the
`contextBuildMs` column shows the server preamble was already about 100 ms and did not move.
The render-side metrics are the ones this batch targets: fewer and shorter main-thread long
tasks while streaming (-7% total, -14% longest), with no regression in stream duration. The
extra DOM mutations come from the committed/tail split rendering two react-markdown
instances; they are cheap (the long-task numbers already include them). The Anthropic retry
budget and the WebSocket byte savings are not visible in this run (OpenAI model, single
tab, no overload); their numbers are in the table above. Raw rows and the probe:
`../bike4mind-chat-latency-ab/` (a sibling directory outside the repo).
