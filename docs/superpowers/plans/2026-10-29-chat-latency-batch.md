# Chat Latency Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven latency fixes from the 2026-10-29 audit (streaming render, reasoning reveal, provider keep-alive, retry budget, WebSocket frame hygiene, preamble round trips, image downscale) with a before/after number for each.

**Architecture:** Client fixes are confined to the streaming reply render path (`PromptReplies`, `ThoughtBubbles`, `useSubscribeChatCompletion`) and the upload helper. Server fixes touch the provider SDK construction in `llm-adapters`, the frame builder in `services/llm/StatusManager`, and two preamble seams in `ChatCompletionProcess` / the Lambda route. No port, schema or wire field is removed; new fields are optional.

**Tech Stack:** TypeScript strict, React 18, react-markdown 10, vitest 4 (two projects in `apps/client`: `node` and `jsdom`), undici 7 (already a dependency of `@bike4mind/llm-adapters`), Node 24.

**Spec:** `docs/superpowers/specs/2026-10-29-chat-latency-batch-design.md`

## Global Constraints

- Node 24 on PATH for every command (`export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`); the default shell has Node 20 and `isolated-vm` will not build there.
- Run package tests with `VITEST_MAX_WORKERS=2 pnpm --filter <pkg> exec vitest run <file>`; client jsdom tests need the `// @vitest-environment jsdom` first line only when the file lives under `server/` or `pages/`.
- ASCII only on added lines in `.ts`/`.tsx` (pre-commit guard rejects curly quotes and dashes). Same convention for `.md`.
- No new npm dependencies. No `any` without a one-line reason. Comments explain why, never what; match the density of the surrounding file.
- No tracker numbers anywhere. Conventional Commit messages, `perf(scope):` for the latency commits.
- Benchmarks are vitest files gated with `describe.skipIf(!process.env.B4M_PERF)` and print their numbers with `console.info`; CI skips them. Each task appends its row to `docs/superpowers/perf/2026-10-29-chat-latency-measurements.md` (created in Task 1).
- Typecheck gate before each commit, scoped to the touched package: `pnpm --filter <pkg> typecheck` (client: `pnpm --filter @bike4mind/client typecheck`).
- `pnpm turbo:core:build` after any change under `b4m-core/*` that `apps/client` tests import through `dist`.

## Review Focus

1. A reply that ends mid code fence while streaming must render the open block as code in the live tail and never as prose in the committed half (Task 1 test `keeps an open fence in the tail`).
2. A completed reply must produce the same DOM as before the split was introduced, footnotes and citation markers included (Task 1 test `renders a completed reply through one ReactMarkdown`).
3. A client that reconnects mid-stream receives a frame without `prompt`; the user's prompt must not vanish from the thread (Task 5 test `keeps the optimistic prompt when the first frame omits it`).
4. A retried quest restarts `seq` from 1 in a new process; the client must not drop its frames as stale (Task 5 test `accepts a lower seq when streamId changes`).
5. When both the spend cap and the admission gate reject a request, the spend-cap error must still be the one surfaced (Task 6 test `spend-cap error wins when both checks fail`).

---

### Task 1: Frozen-prefix streaming markdown

**Files:**
- Create: `apps/client/app/components/Session/markdown/streamingSplit.ts`
- Create: `apps/client/app/components/Session/markdown/streamingSplit.test.ts`
- Create: `apps/client/app/components/Session/markdown/StreamingMarkdown.tsx`
- Create: `apps/client/app/components/Session/markdown/StreamingMarkdown.test.tsx`
- Create: `apps/client/app/components/Session/markdown/StreamingMarkdown.perf.test.tsx`
- Modify: `apps/client/app/components/Session/PromptReplies.tsx:1348-1368` (memoised components object, hoisted rehype array) and `:1863-1876` (swap `ReactMarkdown` for `StreamingMarkdown`)
- Create: `docs/superpowers/perf/2026-10-29-chat-latency-measurements.md`

**Interfaces:**
- Produces: `splitStreamingMarkdown(text: string): { committed: string; tail: string }` (pure).
- Produces: `StreamingMarkdown` React component with props `{ text: string; streaming: boolean; components: Components; remarkPlugins: PluggableList; rehypePlugins: PluggableList; remarkRehypeOptions: RemarkRehypeOptions }` where the plugin/option types are the ones `react-markdown` exports. When `streaming` is false it renders exactly one `<ReactMarkdown>` with `text`; when true it renders `<CommittedMarkdown>` (a `React.memo` wrapper around `ReactMarkdown`) for `committed` followed by a plain `<ReactMarkdown>` for `tail`. No wrapper element around either: `react-markdown` v10 returns a fragment, so the `.b4m-md > *` CSS rules keep applying.

- [ ] **Step 1: Write the failing split tests** in `streamingSplit.test.ts`

```ts
describe('splitStreamingMarkdown', () => {
  it('cuts at the last top-level blank line', () => {
    expect(splitStreamingMarkdown('# A\n\npara one\n\npara two still typ')).toEqual({
      committed: '# A\n\npara one\n\n',
      tail: 'para two still typ',
    });
  });
  it('returns everything as tail when there is no blank line', () => {
    expect(splitStreamingMarkdown('just one paragraph so far')).toEqual({ committed: '', tail: 'just one paragraph so far' });
  });
  it('keeps an open fence in the tail', () => {
    const text = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n';
    expect(splitStreamingMarkdown(text)).toEqual({ committed: 'intro\n\n', tail: '```ts\nconst a = 1;\n\nconst b = 2;\n' });
  });
  it('keeps an open $$ math block in the tail', () => {
    const text = 'intro\n\n$$\na = b\n\nc = d';
    expect(splitStreamingMarkdown(text)).toEqual({ committed: 'intro\n\n', tail: '$$\na = b\n\nc = d' });
  });
  it('commits a closed fence', () => {
    const text = '```js\nx\n```\n\nafter';
    expect(splitStreamingMarkdown(text)).toEqual({ committed: '```js\nx\n```\n\n', tail: 'after' });
  });
  it('keeps a table together while its rows are still streaming', () => {
    const text = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |';
    expect(splitStreamingMarkdown(text).tail.startsWith('| a | b |')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client exec vitest run app/components/Session/markdown/streamingSplit.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `splitStreamingMarkdown`**

Algorithm: find the last `\n\n` boundary; the committed half is everything up to and including it. Count ``` fence markers (lines starting with three backticks or tildes) and lines that are exactly `$$` in the committed half; while either count is odd, move the boundary back to the `\n\n` that precedes the last opening marker. A table is any block whose last non-empty line starts with `|`; it stays in the tail since blocks only commit at a blank line after them. Keep it under 60 lines.

- [ ] **Step 4: Run split tests**

Expected: PASS.

- [ ] **Step 5: Write the failing component tests** in `StreamingMarkdown.test.tsx`

```tsx
it('renders a completed reply through one ReactMarkdown', () => {
  // Spy on react-markdown's default export; expect exactly one call with the full text.
});
it('does not re-render the committed half when only the tail grows', () => {
  // Wrap `components.p` with a render counter. Render streaming text with two committed
  // paragraphs and a tail; rerender with 20 more characters appended to the tail;
  // the counter for the committed paragraphs must not increase.
});
it('keeps an open fence in the tail as a code element', () => {
  // streaming text 'intro\n\n```ts\nconst a = 1;\n' renders a <code> (via components.code) for the fence.
});
```

- [ ] **Step 6: Implement `StreamingMarkdown.tsx`**

`CommittedMarkdown = React.memo(function CommittedMarkdown(props) { return <ReactMarkdown {...props}>{props.text}</ReactMarkdown>; })`. The parent computes `splitStreamingMarkdown(text)` in a `useMemo` keyed on `text` and `streaming`.

- [ ] **Step 7: Run component tests**

Expected: PASS. If the committed counter increases, a prop identity is unstable; fix it in Step 8, not by loosening the test.

- [ ] **Step 8: Wire it into `PromptReplies.tsx`**

Hoist `const REPLY_REHYPE_PLUGINS = [rehypeKatex]` to module scope. Build the `components` object once with `useMemo` over `[markdownComponents, codeComponent, markdownImage, link, CitationMarker]` (check each is referentially stable; `markdownImage` and `link` are `useCallback` already, `CitationMarker` is module-level, verify and fix if not). Replace the `<ReactMarkdown ...>{mathReadyContent}</ReactMarkdown>` block with `<StreamingMarkdown text={mathReadyContent} streaming={!completed} components={...} remarkPlugins={replyRemarkPlugins} rehypePlugins={REPLY_REHYPE_PLUGINS} remarkRehypeOptions={...} />`. The `remarkRehypeOptions` object must also be memoised on `messageId`.

- [ ] **Step 9: Run the existing PromptReplies tests**

Run: `VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client exec vitest run app/components/Session/PromptReplies`
Expected: PASS, same count as on `main`.

- [ ] **Step 10: Write the benchmark** `StreamingMarkdown.perf.test.tsx`

Gated by `B4M_PERF`. Build a ~6 KB markdown answer (two headings, a list, two fenced code blocks, a table, a paragraph with inline math). Feed it in 60 frames of growing prefix. Variant A: `<ReactMarkdown>` with the full prefix each frame. Variant B: `<StreamingMarkdown streaming>`. Measure `performance.now()` around each `act(() => rerender(...))`, print `A total ms`, `B total ms`, `A per-frame p50/max`, `B per-frame p50/max`. Use the same `components` (plain `code`, no Prism) for both variants so the number isolates parsing and reconciliation.

- [ ] **Step 11: Run the benchmark and record**

Run: `B4M_PERF=1 VITEST_MAX_WORKERS=1 pnpm --filter @bike4mind/client exec vitest run app/components/Session/markdown/StreamingMarkdown.perf.test.tsx`
Create `docs/superpowers/perf/2026-10-29-chat-latency-measurements.md` with a header explaining the protocol (from the spec) and a table `| Item | Metric | Before | After | How measured |`. Add the row for this task.

- [ ] **Step 12: Typecheck and commit**

```bash
pnpm --filter @bike4mind/client typecheck
git add apps/client/app/components/Session/markdown apps/client/app/components/Session/PromptReplies.tsx docs/superpowers/perf
git commit -m "perf(client): freeze settled markdown blocks while a reply streams"
```

---

### Task 2: Reasoning text renders as it arrives

**Files:**
- Modify: `apps/client/app/components/Session/ThoughtBubbles.tsx:1,124`
- Delete: `apps/client/app/hooks/useAnimate.tsx` (only consumer is ThoughtBubbles; re-verify with grep before deleting)
- Modify: `apps/client/app/components/Session/ThoughtBubbles.test.tsx`
- Create: `apps/client/app/components/Session/ThoughtBubbles.perf.test.tsx`

**Interfaces:** none new. `ThoughtBubbles` keeps its props.

- [ ] **Step 1: Write the failing test** in `ThoughtBubbles.test.tsx`

```tsx
it('shows the full reasoning text on the render it arrives in', () => {
  // render with content '<think>step one' and isStreaming true; the text 'step one' must be in the
  // document synchronously (no fake timers advanced, no act() waiting).
});
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL (the animated cursor starts at 0 so the text is empty on first render).

- [ ] **Step 3: Implement**

Remove the `useAnimatedText` import and call; render `thoughts` directly where `animatedText` was used. Delete `useAnimate.tsx`. Remove any now-unused `framer-motion` import in ThoughtBubbles (keep the package; other components use it).

- [ ] **Step 4: Run ThoughtBubbles tests**

Expected: PASS. Update any test that asserted the staged reveal to assert immediate text.

- [ ] **Step 5: Benchmark** `ThoughtBubbles.perf.test.tsx` (gated)

Two tiny probe components wrapped in `<React.Profiler onRender>` counting commits: variant A uses an inline copy of the old `useAnimatedText` hook (paste the 38-line body from `main` into the perf file; `framer-motion` stays a dependency) and variant B renders the text directly. Stream 20 frames of reasoning text 100 ms apart with real timers (2 s run) into each. Print `A commits / B commits` and `A ms until the last frame's full text is in the DOM / B ms`.

- [ ] **Step 6: Typecheck, record, commit**

```bash
pnpm --filter @bike4mind/client typecheck
git add apps/client/app/components/Session/ThoughtBubbles.tsx apps/client/app/components/Session/ThoughtBubbles.test.tsx apps/client/app/components/Session/ThoughtBubbles.perf.test.tsx apps/client/app/hooks/useAnimate.tsx docs/superpowers/perf
git commit -m "perf(client): render reasoning text as it streams instead of animating it"
```

---

### Task 3: Shared keep-alive dispatcher for provider SDK clients

**Files:**
- Create: `b4m-core/llm-adapters/src/providerDispatcher.ts`
- Create: `b4m-core/llm-adapters/src/providerDispatcher.test.ts`
- Create: `b4m-core/llm-adapters/src/providerDispatcher.perf.test.ts`
- Modify: `b4m-core/llm-adapters/src/anthropicBackend.ts:275-281`
- Modify: `b4m-core/llm-adapters/src/openaiBackend.ts:146,185`
- Modify: `b4m-core/llm-adapters/src/kimiBackend.ts:72`, `xaiBackend.ts:74`, `deepseekBackend.ts:78`

**Interfaces:**
- Produces: `providerDispatcher(): Agent` (module singleton, `new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 })` from `undici`).
- Produces: `providerFetchOptions(): { dispatcher: Agent }` typed to satisfy both SDKs' `fetchOptions` (`MergedRequestInit`); one cast at the boundary with a one-line reason (lib.dom `RequestInit` has no `dispatcher`).

- [ ] **Step 1: Write the failing tests** in `providerDispatcher.test.ts`

```ts
it('returns the same Agent on every call', () => { expect(providerDispatcher()).toBe(providerDispatcher()); });
it('AnthropicBackend passes the dispatcher to fetch', async () => {
  // Pattern from anthropicBackend.rateLimitLogging.test.ts: vi.stubGlobal('fetch', mock resolving a
  // minimal SSE response); construct AnthropicBackend('key'); call the streaming entry point used
  // in that test; assert fetchMock.mock.calls[0][1].dispatcher === providerDispatcher().
});
it('OpenAIBackend passes the dispatcher to fetch', async () => { /* same shape */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/llm-adapters exec vitest run src/providerDispatcher.test.ts`

- [ ] **Step 3: Implement** the module and add `fetchOptions: providerFetchOptions()` to each `new Anthropic(...)` / `new OpenAI(...)` listed above (including the federated OpenAI client).

- [ ] **Step 4: Run the llm-adapters suite**

Run: `VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/llm-adapters test`
Expected: PASS.

- [ ] **Step 5: Benchmark** `providerDispatcher.perf.test.ts` (gated; needs network, no API key)

Subscribe to `diagnostics_channel.channel('undici:client:connected')`. For variant A (built-in global dispatcher) and B (`providerDispatcher()`): 4 sequential `fetch('https://api.anthropic.com/v1/models', { headers: { 'anthropic-version': '2023-06-01' } })` calls (a 401 is fine), 5 s sleep between calls, measure each call's wall time and count `connected` events. Print `A connects / B connects` and `A per-call ms / B per-call ms`. The expectation is A=4 connects, B=1.

- [ ] **Step 6: Record, typecheck, commit**

```bash
pnpm --filter @bike4mind/llm-adapters typecheck
git add b4m-core/llm-adapters/src/providerDispatcher.ts b4m-core/llm-adapters/src/providerDispatcher.test.ts b4m-core/llm-adapters/src/providerDispatcher.perf.test.ts b4m-core/llm-adapters/src/anthropicBackend.ts b4m-core/llm-adapters/src/openaiBackend.ts b4m-core/llm-adapters/src/kimiBackend.ts b4m-core/llm-adapters/src/xaiBackend.ts b4m-core/llm-adapters/src/deepseekBackend.ts docs/superpowers/perf
git commit -m "perf(llm-adapters): keep provider connections alive across turns"
```

---

### Task 4: Bound the pre-token retry budget

**Files:**
- Modify: `b4m-core/llm-adapters/src/anthropicBackend.ts:279` (`maxRetries: 5` -> `2`) and `:1595` (`withRetry` `maxRetries: 3` -> `1`)
- Modify: `b4m-core/llm-adapters/src/openaiBackend.ts` (`withRetry` at the two stream-open sites, `maxRetries: 3` -> `1`)
- Create: `b4m-core/llm-adapters/src/retryBudget.perf.test.ts`
- Modify: any test asserting the old attempt counts (grep `maxRetries`, `onRetry`, `attempt` in `src/*.test.ts`)

**Interfaces:** none new.

- [ ] **Step 1: Write the budget test** `retryBudget.perf.test.ts` (NOT gated; it is fast with fake timers and pins the budget)

```ts
it('a sustained 529 costs at most 6 HTTP attempts before the error surfaces', async () => {
  // vi.useFakeTimers(); stub fetch to always return 529 with a JSON overloaded_error body;
  // construct AnthropicBackend('key'); start the streaming call; vi.runAllTimersAsync();
  // expect the call to reject and fetch call count to be 6; print total fake time elapsed.
});
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL with 24 attempts (count printed).

- [ ] **Step 3: Change the four numbers** listed in Files.

- [ ] **Step 4: Run the llm-adapters suite**

Expected: PASS after updating any test that pinned the old counts. Keep the `transportRetry.ts` layer and `retryFetch` untouched.

- [ ] **Step 5: Record** before/after attempts and elapsed fake ms in the measurements doc, then commit

```bash
git commit -m "perf(llm-adapters): bound pre-token retries so overloads surface in seconds"
```

---

### Task 5: Frame sequence numbers and static-field dedupe

**Files:**
- Modify: `b4m-core/common/src/schemas/actions.ts:377` (add optional `seq: z.number()`, `streamId: z.string()` to the `streamed_chat_completion` action)
- Modify: `b4m-core/services/src/llm/StatusManager.ts` (constructor, `createOptimizedPayload`, `doSendStatusUpdate`)
- Modify: `b4m-core/services/src/llm/StatusManager.test.ts`
- Create: `b4m-core/services/src/llm/StatusManager.perf.test.ts`
- Modify: `b4m-core/services/src/llm/ChatCompletionProcess.ts:4762-4766` (inverted throttle log)
- Modify: `apps/client/app/hooks/useSubscribeChatCompletion.ts:296-310`
- Modify: `apps/client/app/hooks/useStreamingQueryUpdates.ts:64-79`
- Modify/Create: tests next to the two hooks

**Interfaces:**
- Produces on the wire: `{ action: 'streamed_chat_completion', quest, status, seq?: number, streamId?: string }`. `streamId` is a random id per `StatusManager` instance; `seq` starts at 1 and increments per frame actually sent.
- Produces in `StatusManager`: private `lastStaticByQuest: Map<string, { prompt?: string; images?: string; citables?: string; artifacts?: string }>` (JSON strings for the array fields).

- [ ] **Step 1: Write the failing server tests** in `StatusManager.test.ts`

```ts
it('stamps seq and streamId on every frame and increments seq per sent frame', ...);
it('sends prompt, images, citables and artifacts on the first frame of a quest', ...);
it('omits unchanged prompt and citables on later frames of the same quest', ...);
it('re-sends citables when they change and sends an explicit empty array when they clear', ...);
it('sends the full static set on a terminal frame', ...);  // status 'done' | 'stopped' | 'error' (reuse the shared terminal-status helper if one exists in @bike4mind/common; grep isTerminalQuestStatus)
it('a full-payload frame (skipPayloadOptimization) is unaffected', ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/services exec vitest run src/llm/StatusManager.test.ts`

- [ ] **Step 3: Implement in `StatusManager.ts`**

Remove the dead `throttledSend` field and its constructor block. Add `seq`/`streamId`. In `createOptimizedPayload` (optimized branch only) consult `lastStaticByQuest` for the quest id: include a static field when the quest has no entry yet, when the frame is terminal, or when the serialised value differs; update the entry after building. `prompt` stays as-is in the type (optional already via `Partial`). Fix the log line in `ChatCompletionProcess.ts:4762` so it reports DISABLED only when `DISABLE_SERVER_THROTTLING` is set.

- [ ] **Step 4: Run services tests for the file**

Expected: PASS.

- [ ] **Step 5: Write the failing client tests**

In the test for `useSubscribeChatCompletion` (create `useSubscribeChatCompletion.seq.test.tsx` if the existing test file is too coupled; mock the subscription the way the existing tests do):

```ts
it('drops a frame whose seq is lower than the last one for the same streamId', ...);
it('accepts a lower seq when streamId changes', ...);
it('falls back to the updatedAt rule when seq is absent', ...);
```

In `useStreamingQueryUpdates.test.ts` (create if absent):

```ts
it('keeps the optimistic prompt when the first frame omits it', () => {
  // seed cache ['quests','session','s1'] with pages [{ data: [{ id: 'optimistic-quest-s1', prompt: 'hello', _optimistic: true }] }]
  // call updateStreamingQuest({ id: 'q1', sessionId: 's1', replies: ['hi'] })
  // expect the cache row for q1 to carry prompt 'hello'
});
```

- [ ] **Step 6: Implement the client side**

Stale guard: keep `lastProcessedQuestRef`; add `lastSeqRef: { current: { questId: string; streamId: string; seq: number } | null }`. If the frame carries `seq` and `streamId` and matches the ref's `questId` and `streamId`, drop when `seq < ref.seq` (terminal frames still always pass, as today); otherwise reset the ref. First-frame replace: read the optimistic row from the cache and pass `{ ...optimisticRow, ...questForUpdate }` to `replaceQueryData` (check whether `replaceQueryData` already merges `existing`; if it does, the test passes without changes and you only add the test).

- [ ] **Step 7: Run the client hook tests**

Expected: PASS.

- [ ] **Step 8: Benchmark** `StatusManager.perf.test.ts` (gated)

200 frames of a reply growing 10 chars per frame, with `prompt` of 1 KB and `promptMeta.citables` serialising to 20 KB on every frame. Sum `JSON.stringify(sendToClient.mock.calls[i][2]).length`. Variant A reproduces the old behaviour by calling with `skipPayloadOptimization: false` on a `StatusManager` whose `lastStaticByQuest` is cleared before every frame (expose a test-only `resetStaticFields()` or construct a new manager per frame). Print `A bytes / B bytes`.

- [ ] **Step 9: Typecheck, build, record, commit**

```bash
pnpm --filter @bike4mind/common typecheck && pnpm --filter @bike4mind/services typecheck && pnpm --filter @bike4mind/client typecheck
pnpm turbo:core:build
git add b4m-core/common/src/schemas/actions.ts b4m-core/services/src/llm/StatusManager.ts b4m-core/services/src/llm/StatusManager.test.ts b4m-core/services/src/llm/StatusManager.perf.test.ts b4m-core/services/src/llm/ChatCompletionProcess.ts apps/client/app/hooks docs/superpowers/perf
git commit -m "perf(streaming): sequence frames and stop re-sending unchanged prompt and citables"
```

---

### Task 6: Preamble round trips and token breakdown

**Files:**
- Modify: `b4m-core/services/src/llm/modelAdmission.ts` (add `loadModelAdmissionSettings`)
- Modify: `b4m-core/services/src/llm/modelAdmission.test.ts` (exists? create if not)
- Modify: `b4m-core/services/src/llm/ChatCompletionProcess.ts:2591-2601` and `:4125-4133`
- Modify: `apps/client/pages/api/ai/llm.ts:92-103`
- Modify: `apps/client/pages/api/ai/__tests__/llm*.test.ts` (whichever covers the spend cap / admission path)
- Create: `b4m-core/services/src/llm/tokenBreakdown.perf.test.ts`

**Interfaces:**
- Produces: `loadModelAdmissionSettings(adminSettings): Promise<{ configs: LLMModelConfig[]; freeTierAllowedModels: ReadonlySet<string> | undefined }>` running both existing loaders with `Promise.all`.
- Produces in `llm.ts`: `runPreDispatchChecks({ spendCap: () => Promise<void>, admit: () => Promise<void> }): Promise<void>` via `Promise.allSettled`, rethrowing the spend-cap rejection first, else the admission rejection.

- [ ] **Step 1: Write the failing tests**

`modelAdmission.test.ts`:
```ts
it('loads configs and the free-tier allowlist concurrently', async () => {
  // adminSettings.findOne / findAll return deferred promises; assert both were called before either resolves.
});
```
`llm` route test:
```ts
it('spend-cap error wins when both checks fail', async () => { /* both mocks reject; expect the 429 spend-cap response */ });
it('runs the spend cap and admission checks concurrently', async () => { /* both mocks pending; both called */ });
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement** the two helpers and call sites. In `ChatCompletionProcess.ts` replace the two sequential `await`s inside `createModelAdmission({...})` with one `await loadModelAdmissionSettings(this.db.adminSettings)` above it.

- [ ] **Step 4: Token breakdown**

Grep every consumer of `mementoTokens`, `fabTokens`, `urlTokens`, `historyTokens`, `userPromptTokens` after `:4125`. If they only feed `promptMeta` / logs / analytics (expected), switch those five calls to `{ ...tokenCalcOptions, estimateOnly: true }` and leave `totalTokens` exact. If any feeds a decision (budget, trimming, billing), leave that one exact and note it in the measurements doc. Add a one-line comment above the call stating that the subsets are estimates because they are informational.

- [ ] **Step 5: Benchmark** `tokenBreakdown.perf.test.ts` (gated)

Build 40 messages of ~1000 tokens each with the real `TiktokenTokenizer` (see `apps/client/server/utils/chatCompletionDefaults.ts:313` for construction; if it is not importable from `services` tests, use the tokenizer class from `@bike4mind/utils` directly). Time variant A (six exact counts as before) vs B (one exact + five estimates). Print both in ms.

- [ ] **Step 6: Run tests, typecheck, build, record, commit**

```bash
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/services exec vitest run src/llm/modelAdmission.test.ts
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client exec vitest run --project node pages/api/ai/__tests__
pnpm --filter @bike4mind/services typecheck && pnpm --filter @bike4mind/client typecheck && pnpm turbo:core:build
git commit -m "perf(chat): overlap admission reads and estimate the informational token breakdown"
```

---

### Task 7: Downscale images to 1568 px before upload

**Files:**
- Modify: `apps/client/app/utils/imageResizer.ts` (add `planImageResize`, extend `resizeImageFile`)
- Create: `apps/client/app/utils/imageResizer.test.ts`
- Modify: `apps/client/app/utils/filesAPICalls.ts:77-100`

**Interfaces:**
- Produces: `planImageResize(input: { type: string; sizeBytes: number; width: number; height: number }): { resize: false } | { resize: true; width: number; height: number; outputType: 'image/png' | 'image/jpeg'; quality: number }` (pure). Constants `MAX_UPLOAD_EDGE_PX = 1568`, `JPEG_QUALITY = 0.8`, existing `maxSizeMB = 3`.
- Produces: `prepareImageForUpload(file: File): Promise<File>` which decodes dimensions (`createImageBitmap` with an `Image` fallback), calls `planImageResize`, and returns the original `File` when `resize` is false.

- [ ] **Step 1: Write the failing plan tests**

```ts
it('leaves a 1200x900 jpeg under 3MB untouched', ...);           // { resize: false }
it('downscales a 4000x3000 jpeg to 1568x1176 jpeg q0.8', ...);
it('keeps png as png when downscaling', ...);
it('leaves svg and animated gif untouched regardless of size', ...);  // type 'image/svg+xml', 'image/gif'
it('still downscales a 1400x1400 png over 3MB (size rule survives)', ...);
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement** `planImageResize` and `prepareImageForUpload`; make `createFabFileOnServerWithUpload` call `prepareImageForUpload(file)` instead of the inline `> 3 MB` branch, keeping the `formData.mimeType` sync when the type changes. Keep the console logs' shape (they are read in support sessions).

- [ ] **Step 4: Run tests and the existing upload tests**

Run: `VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client exec vitest run app/utils/imageResizer app/utils/filesAPICalls`

- [ ] **Step 5: Record**

jsdom cannot encode canvases, so the measurement is the pixel budget: record for a 12 MP (4000x3000) photo `pixels before 12.0 MP / after 1.84 MP (6.5x)` and the policy change `resize threshold: >3 MB only -> any edge >1568 px`. State plainly in the doc that byte savings were not measured in a browser here.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @bike4mind/client typecheck
git commit -m "perf(client): downscale images to 1568px before upload"
```

---

### Task 8: Whole-batch verification and measurement roll-up

**Files:**
- Modify: `docs/superpowers/perf/2026-10-29-chat-latency-measurements.md`

- [ ] **Step 1: Run every gated benchmark once more at head** and make sure the doc rows match the printed numbers.

- [ ] **Step 2: Package suites**

```bash
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/llm-adapters test
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/services exec vitest run src/llm
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client exec vitest run app/components/Session app/hooks app/utils pages/api/ai
```
Expected: all PASS.

- [ ] **Step 3: Typecheck and lint**

```bash
pnpm turbo:typecheck
pnpm lint:check
```

- [ ] **Step 4: Commit the doc**

```bash
git add docs/superpowers/perf/2026-10-29-chat-latency-measurements.md
git commit -m "docs(perf): record before/after numbers for the chat latency batch"
```
