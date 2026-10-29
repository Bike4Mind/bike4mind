# Chat latency batch (2026-10-29) - design

## Intent

Port the latency wins proven in the sibling b4m-chat project into the main app without
changing behaviour users rely on. Every change ships with a before/after measurement and
keeps the existing regression guards green (unit suites, `turnTiming`,
`promptMeta.performance.firstTokenTime`, the e2e `ai-latency` gate).

## What the audit found already done (not in scope)

Raw provider streams (no SDK `.stream()` helpers), prompt-cache layout, lean projected
history reads, MCP schemas from the Mongo cache, singleton tokenizer, post-stream work
off the hot path, 202 ACK dispatch to the always-on container, 100 ms server-side frame
throttle with leading edge, 10 s heartbeat save, optimistic prompt bubble.

## Goals

1. Perceived streaming smoothness: stop re-parsing the whole reply through
   react-markdown + KaTeX + Prism on every frame; stop the 2 s framer animation on
   reasoning text.
2. Provider TTFT: reuse TLS connections to provider APIs across turns; bound the worst
   case wait on 429/529 before a token or an error surfaces.
3. Wire efficiency: stop re-sending unchanged `prompt` / `citables` / `artifacts` /
   `images` on every WebSocket frame; add a sequence number so stale frames can be
   rejected deterministically.
4. Preamble: remove serial round trips that have no data dependency; stop encoding the
   full prompt twice for the token breakdown.
5. Uploads: cap image long edge at 2576 px (the most any current provider reads) before upload.

## Non-goals / anti-goals

- No change to the WebSocket snapshot semantics (frames still carry the full `replies`
  array). Switching to deltas touches too many consumers; deferred.
- No change to authorization or billing outcomes. Parallelised checks must surface the
  same error, with the same precedence, as the serial code.
- No change to the final rendered markdown once a reply is complete.
- No new npm dependencies (`undici` is already a dependency of `llm-adapters`).
- No index changes, no wire-contract removals (new fields are additive and optional).

## Decisions

- **Frozen prefix split** happens only while streaming. Each settled block and the live
  tail render through their own `ReactMarkdown`, keyed by block index, so a block keeps its
  React identity (and per-block state such as an approved image) when it settles; node
  positions are shifted back to reply-relative lines. A reply that streamed in this view
  keeps that structure once complete, so no block remounts at the end of the stream, unless
  the text holds a footnote, a link reference definition or an HTML block; then, and for any
  reply mounted already complete, the whole reply renders through one `ReactMarkdown` exactly
  as today, so footnotes, citation markers and heading ids resolve identically to the current
  final render.
- Split rule: a block ends at a blank line (spaces and tabs only) followed by a line that
  starts a new top-level block. Blank lines inside a fence (CommonMark opener/closer rules),
  a `$$` block or a list, and a blank line before a link reference definition, never end a
  block. Footnote references render raw until completion.
- **Reasoning text** renders as it arrives (server already throttles at 100 ms). The
  framer-motion reveal is removed, not slowed.
- **Keep-alive**: one shared `undici.Agent` (60 s keep-alive, 10 min max) passed to the
  provider SDK clients via `fetchOptions.dispatcher`. Clients are still constructed per
  turn (cheap); the socket pool is what gets shared.
- **Retries**: Anthropic SDK `maxRetries` 5 -> 2 (keeps `retry-after` handling in the one
  layer that understands it); app-level `withRetry` around stream open 3 -> 1 for
  Anthropic and OpenAI. The 2-attempt transport retry (`terminated` / `fetch failed`)
  stays. Worst case on a sustained 529 drops from 24 HTTP attempts (~65 s of backoff) to
  6 attempts (~3.5 s).
- **Frames**: `seq` + `streamId` ride on the action envelope, not inside `quest`. The
  client prefers `seq` when `streamId` matches the last frame for that quest, else falls
  back to the existing `updatedAt` rule. Static fields are included on the first frame of
  a quest, on terminal frames, whenever their value changed, and every 20 frames (a frame
  can be lost per connection without the sender rejecting, or dropped by the seq guard);
  otherwise omitted. The client merges frames over the previous quest and also remembers
  each quest's statics (per quest id and `streamId`, so a retry starts clean) so a frame
  that omits them is whole after a session switch. Frames are built at call time and
  delivered concurrently, as before.
- **Preamble**: the two admin-settings reads behind `createModelAdmission` run in
  parallel; the Lambda's spend-cap and admission checks run in parallel with the
  spend-cap error taking precedence when both fail and returning without waiting for the
  admission read. The token breakdown stays exact: the estimator was tried and reverted
  because its per-source buckets were off by 20-50% on mixed content.
- **Images**: any chat-attachment raster image whose long edge exceeds 2576 px (the
  most any current provider reads; the server still applies its per-provider cap) is
  downscaled on the client; PNG stays PNG, WebP/AVIF become WebP (alpha kept), other
  formats become JPEG q0.8; animated GIF and SVG are left alone; the existing >3 MB rule
  still applies after the dimension rule, and an in-budget original is kept when the
  re-encode would be larger (WebKit cannot encode WebP and falls back to PNG).

## Measurement protocol

Benchmarks live next to the code as vitest files gated by `B4M_PERF=1` so CI skips
them. Each prints a before/after pair (A/B inside one run where the old path can be
reproduced in-process; otherwise the same file is run at the baseline commit and at
head). Numbers are recorded in
`docs/superpowers/perf/2026-10-29-chat-latency-measurements.md`. End-to-end TTFT is
validated on a preview deploy through the existing e2e `ai-latency` suites, not here.
