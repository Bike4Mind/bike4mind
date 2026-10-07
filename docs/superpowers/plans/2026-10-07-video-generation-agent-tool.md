# Video Generation Agent Tool Implementation Plan (Phase 5 of #3890)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the chat agent start a video job (text-to-video or image-to-video) through a non-blocking `video_generation` tool, and render the resulting job as a live `VideoJobCard` in the reply.

**Architecture:** The tool lives in `b4m-core/services` but cannot reach app wiring, so the app injects a per-request `VideoToolConfig` (`usableModels` + `createJob`) into `ChatCompletionProcess.process()`, the same way `externalTools` is injected. `buildSharedTools` gates the tool on that config being present and non-empty. The tool's Zod schema is generated from the usable models' catalog capabilities, validates nothing itself (`createVideoJob` is the single validator and the single billing point, `source: 'agent'`), and returns `{ jobId, estimatedSeconds }` immediately. The job id is recorded on the quest as `videoJobIds`; the client renders one `VideoJobCard` per id, fed by the existing global `VideoGenerationUpdatesListener`.

**Tech Stack:** TypeScript (strict), Zod, Vitest (`node` + `jsdom` projects), Mongoose, React Query, MUI Joy, SST (infra).

**Spec:** Epic #3890 phase 5, in the phase 4 plan `docs/superpowers/plans/2026-10-07-video-generation-studio.md` (Out of scope list) and the job engine code under `b4m-core/services/src/videoJobs/`.

## Plan-time corrections to the pre-made decisions

1. **`video_generation` is not in `b4mLLMTools` yet.** It exists only in `EXTERNAL_REGISTRY_SIDE_EFFECTS` and `TOOLS_REQUIRING_APPROVAL`. Adding the enum entry makes `b4mTools` (`satisfies`), `CORE_TOOL_SIDE_EFFECTS` and the client `TOOL_MAPPING` (exhaustive `Record`) fail to compile, so all of them land in one commit (Task 3). The existing `toolSideEffects.test.ts` forbids the same name in both registries, so the entry is moved, not copied.
2. **Gating is central, not in `toolAvailability.ts`/`serverConfig`.** The client already uses `useVideoModels` for the studio. The gate is one line in `buildSharedTools` (Task 4), which also covers the agent executor, Slack and voice paths for free: they never pass a config, so they silently lack the tool.
3. **No tool call id exists.** `ToolContext` has none and `toolFn(parameters, apiKey)` only gets args. The idempotency key is `agent:{userId}:{questId}:{sha256(request).slice(0,32)}`, omitted when there is no `questId`. Side effect: two identical calls in one turn dedupe to one job (intended).
4. **The tool never calls `onStart`/`onFinish`**, so `ToolBuilder`'s billing branches and `resolveToolStatus`/`TOOL_PREAMBLES` are unchanged (one comment at the billing branches, Task 3).
5. **Streaming merge replaces, it does not append.** Frames carry the full accumulated `videoJobIds`, so `useStreamingMessageMerge` uses a fallback-replace (Task 8).
6. **Three more carriers of `videoJobIds`** beyond schema+model: `StatusManager.createOptimizedPayload`, the `QuestModel` projections, and `questTimeoutRecovery` (Task 5). `applyQuestStatusChanges` also needs a Set-dedupe accrete branch, mirroring `images`.
7. **Infra is required.** The `ChatCompletion` Fargate service lacks the `generationJobQueue` link and `TEST_VIDEO_PROVIDER_ENVIRONMENT`; without them `enqueueGenerationJob` throws and the test provider is absent on previews (Task 7).
8. **Lazy resolution.** The capability is resolved only when `video_generation` is in `enabledTools`, and a resolver failure degrades to "no tool" with a warning (Task 4), never a failed turn.
9. **`typicalRenderSeconds` stays internal.** `toPublicVideoModel` builds explicit keys, so nothing leaks to the public API. Fixtures needing the new field: `catalog.test.ts`, `validate.test.ts`, `estimateCost.test.ts`.
10. **`ReplyContainer` is not exported**, so a small `GeneratedVideoJobs` component is extracted to make card-per-id rendering testable (Task 8).
11. **Only `questProcessor` is wired.** `pages/api/chat.ts`, Slack and voice get no tool (see Out of scope).
12. **Image input is uploaded fabFile ids only.** Generated-image storage keys are not accepted by `loadInputImage` (owner-only fabFile lookup), so the tool describes `inputImageFileId` accordingly rather than mirroring `edit_image`'s key forms.

## Execution order

Tasks 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9. Each commits green on its own: Task 3 is the only task that flips the enum and must carry every exhaustive-registry change with it. Tasks 7 (infra) and 8 (client) only depend on Task 5.

## Global Constraints

- ASCII only on added `.ts`/`.tsx` lines (write a typographic character as a `\u2014`-style escape if a typographic character is truly needed).
- No `any`; `unknown` + type guards. Comments only for non-obvious why; no restating code.
- Public repo: no tracker numbers other than #3890/#3968, no customer or overlay details in code, commits or PR text.
- Tests co-located (`Foo.test.ts` beside `Foo.ts`); files under `pages/` use `__tests__/`. Joy component tests wrap in `CssVarsProvider` with `extendTheme({ ...getThemeConfig() })`. `data-testid` is `component-action-element`.
- DB tests use `createMongoServer()`.
- Billing stays in the job engine (`createVideoJob` holds credits). The tool never touches `ToolBuilder` billing.
- Do not add `video_generation` to the agent-mode `allowedTools`. Do not touch `schemas/quest.ts` (public) or the legacy quest `videos` field.
- Conventional Commits; no Co-Authored-By trailer.

| Task | Command |
|------|---------|
| One services test | `pnpm --filter @bike4mind/services exec vitest run <path>` |
| One common test | `pnpm --filter @bike4mind/common exec vitest run <path>` |
| One database test | `pnpm --filter @bike4mind/database exec vitest run <path>` |
| One client test (node) | `pnpm --filter @bike4mind/client exec vitest run --project node <path>` |
| One client test (jsdom) | `pnpm --filter @bike4mind/client exec vitest run --project jsdom <path>` |
| Rebuild core after common/services edits | `pnpm turbo:core:build` |
| Typecheck | `pnpm turbo:typecheck` |
| Lint | `pnpm lint:check` |

Long runs (typecheck, full suites, build) go to a `verify` subagent.

## Review Focus

1. **Zero usable models**: the tool must not be offered at all (not offered-then-failing). Pinned by `sharedToolBuilder.videoGate.test.ts` (Task 4).
2. **Resolver throws** (settings read or key lookup fails): the turn proceeds without the tool and logs a warning. Pinned by `resolveVideoToolConfigSafely.test.ts` (Task 4).
3. **Provider refusal or insufficient credits**: the model gets a readable error string it can relay, no job id is recorded on the quest, and nothing throws. Pinned by `videoGeneration.test.ts` "returns a readable error and records no job" (Task 3).
4. **Same-turn duplicate call / retry**: one job, not two holds. Pinned by the idempotency-key cases in `videoGeneration.test.ts` (Task 3) and the `applyQuestStatusChanges` dedupe case (Task 5).
5. **Reload mid-render**: `videoJobIds` survives the stream, the minimal payload and a refetch, so the card re-attaches to its job. Pinned by the `StatusManager` payload test (Task 5) and the `useStreamingMessageMerge` replace test (Task 8).

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `b4m-core/common/src/video/types.ts`, `catalog.ts` (+3 test fixtures) | Modify | `typicalRenderSeconds` per model |
| `b4m-core/services/src/llm/tools/implementation/videoGeneration/buildSchema.ts` (+test) | Create | Zod schema + tool description from usable models |
| `b4m-core/services/src/llm/tools/implementation/videoGeneration/index.ts` (+test) | Create | Tool definition, `VideoToolConfig`, `isVideoToolConfig` |
| `b4m-core/common/src/schemas/llm.ts`, `toolSideEffects.ts` | Modify | Enum entry; side effect moved to core record |
| `b4m-core/services/src/llm/tools/index.ts` | Modify | `b4mTools` entry |
| `apps/client/app/utils/toolMapping.ts`, `app/constants/tools.tsx`, `Session/AISettings/ToolsSection.tsx` | Modify | UI registration |
| `b4m-core/services/src/llm/sharedToolBuilder.ts` (+gate test) | Modify | Central gate, config passthrough |
| `b4m-core/services/src/llm/resolveVideoToolConfigSafely.ts` (+test) | Create | Safe lazy resolver |
| `b4m-core/services/src/llm/ChatCompletionProcess.ts` | Modify | `videoToolConfigResolver` param |
| `SessionTypes.ts`, `schemas/actions.ts`, `QuestModel.ts`, `StatusManager.ts`, `ToolBuilder.ts`, `questTimeoutRecovery.ts` | Modify | `videoJobIds` end to end |
| `apps/client/server/videoGenerations/buildVideoToolConfig.ts` (+test) | Create | App-side capability |
| `apps/client/server/queueHandlers/questProcessor.ts` | Modify | Pass the resolver |
| `infra/chatCompletion.ts` | Modify | Queue link + test provider env |
| `useStreamingMessageMerge.ts`, `UserPromptTypes.ts`, `GeneratedVideoJobs.tsx` (+test), `PromptReplies.tsx` | Modify/Create | Card per job id |

---

### Task 1: typicalRenderSeconds in the catalog

**Files:**
- Modify: `b4m-core/common/src/video/types.ts`, `b4m-core/common/src/video/catalog.ts`
- Test: `b4m-core/common/src/video/catalog.test.ts`, fixtures in `validate.test.ts` (~line 16) and `estimateCost.test.ts` (~line 17)

**Interfaces:**
- Produces: `VideoModelCapabilities.typicalRenderSeconds: number` (required).

- [ ] **Step 1: Failing test.** Append to `catalog.test.ts`:

```ts
it('gives every model a positive typical render time', () => {
  for (const id of VIDEO_MODEL_IDS) {
    expect(getVideoModelCapabilities(id).typicalRenderSeconds).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2:** `pnpm --filter @bike4mind/common exec vitest run src/video/catalog.test.ts` -> FAIL (undefined).
- [ ] **Step 3: Implement.** In `types.ts` add to `VideoModelCapabilities` (after `defaults`):

```ts
  // Rough wall-clock render time, only used to set the agent's expectation. Not part of the public API.
  typicalRenderSeconds: number;
```

In `catalog.ts` add one property per model: `test-video: 8`, `gemini-omni-1.1-flash: 90`, `grok-imagine-video-1.5: 60`, `veo-3.1-fast-generate-preview: 90`. Add `typicalRenderSeconds: 8` to the capability fixtures in `validate.test.ts` and `estimateCost.test.ts`.
- [ ] **Step 4:** run the three test files plus `pnpm --filter @bike4mind/common typecheck` -> PASS.
- [ ] **Step 5: Commit**

```bash
git add b4m-core/common/src/video
git commit -m "feat(video): add typical render time to the model catalog"
```

---

### Task 2: Schema builder from usable models

**Files:**
- Create: `b4m-core/services/src/llm/tools/implementation/videoGeneration/buildSchema.ts`
- Test: `.../videoGeneration/buildSchema.test.ts`

**Interfaces:**
- Consumes: `VIDEO_MODEL_CATALOG`, `VideoModelId`, `VideoModelCapabilities` from `@bike4mind/common`.
- Produces: `buildVideoToolSchema(usableModels: readonly [VideoModelId, ...VideoModelId[]]): { schema; description: string }`, `type VideoToolArgs`.

Design: `model` is `z.enum(usableModels)`. Duration is `z.number().int().min(minOfAll).max(maxOfAll)`; per-model strictness is left to `validateAgainstCapabilities` inside `createVideoJob` (no clamping). The description lists, per model, modes, duration, aspect ratios, resolutions and typical render seconds, so the LLM can choose. `inputImageFileId` is optional and its presence implies image-to-video.

- [ ] **Step 1: Failing tests.**

```ts
import { describe, expect, it } from 'vitest';
import { buildVideoToolSchema } from './buildSchema';

describe('buildVideoToolSchema', () => {
  it('only accepts usable models', () => {
    const { schema } = buildVideoToolSchema(['test-video']);
    expect(schema.safeParse({ model: 'test-video', prompt: 'a cat' }).success).toBe(true);
    expect(schema.safeParse({ model: 'veo-3.1-fast-generate-preview', prompt: 'a cat' }).success).toBe(false);
  });

  it('spans the duration bounds of every usable model', () => {
    const { schema } = buildVideoToolSchema(['test-video', 'veo-3.1-fast-generate-preview']);
    expect(schema.safeParse({ model: 'test-video', prompt: 'x', durationSeconds: 10 }).success).toBe(true);
    expect(schema.safeParse({ model: 'test-video', prompt: 'x', durationSeconds: 11 }).success).toBe(false);
  });

  it('describes each model with its render time', () => {
    const { description } = buildVideoToolSchema(['test-video']);
    expect(description).toContain('test-video');
    expect(description).toContain('about 8s');
  });

  it('documents inputImageFileId as an uploaded file id', () => {
    const { schema } = buildVideoToolSchema(['test-video']);
    expect(schema.shape.inputImageFileId.description).toMatch(/uploaded/i);
  });
});
```

- [ ] **Step 2:** run -> FAIL (module missing).
- [ ] **Step 3: Implement.**

```ts
import { z } from 'zod';
import {
  ASPECT_RATIOS,
  RESOLUTION_TIERS,
  VIDEO_MODEL_CATALOG,
  type VideoModelCapabilities,
  type VideoModelId,
} from '@bike4mind/common';

const durationBounds = (caps: VideoModelCapabilities): { min: number; max: number } =>
  caps.duration.kind === 'range'
    ? { min: caps.duration.min, max: caps.duration.max }
    : { min: Math.min(...caps.duration.values), max: Math.max(...caps.duration.values) };

const describeDuration = (caps: VideoModelCapabilities): string =>
  caps.duration.kind === 'range'
    ? `${caps.duration.min}-${caps.duration.max}s`
    : `one of ${caps.duration.values.join('/')}s`;

const describeModel = (id: VideoModelId): string => {
  const caps = VIDEO_MODEL_CATALOG[id];
  return (
    `- ${id} (${caps.displayName}): ${caps.modes.join(', ')}; duration ${describeDuration(caps)}; ` +
    `aspect ${caps.aspectRatios.join(', ')}; resolution ${caps.resolutions.join(', ')}; ` +
    `renders in about ${caps.typicalRenderSeconds}s`
  );
};

export function buildVideoToolSchema(usableModels: readonly [VideoModelId, ...VideoModelId[]]) {
  const bounds = usableModels.map(id => durationBounds(VIDEO_MODEL_CATALOG[id]));
  const min = Math.min(...bounds.map(b => b.min));
  const max = Math.max(...bounds.map(b => b.max));
  const schema = z.object({
    model: z.enum(usableModels).describe('Which video model to use'),
    prompt: z.string().min(1).max(4000).describe('What the clip should show'),
    durationSeconds: z.number().int().min(min).max(max).optional().describe('Clip length; must fit the chosen model'),
    aspectRatio: z.enum(ASPECT_RATIOS).optional(),
    resolution: z.enum(RESOLUTION_TIERS).optional(),
    inputImageFileId: z
      .string()
      .optional()
      .describe('Id of an uploaded image file to animate (image-to-video). Omit for text-to-video.'),
  });
  const description = [
    'Start generating a short video clip. Returns immediately with a job id; the clip renders in the background',
    'and appears in the reply as a card. Do not wait for it or promise a result time beyond the estimate.',
    'Available models:',
    ...usableModels.map(describeModel),
  ].join('\n');
  return { schema, description };
}

export type VideoToolArgs = z.infer<ReturnType<typeof buildVideoToolSchema>['schema']>;
```

- [ ] **Step 4:** run -> PASS; `pnpm --filter @bike4mind/services typecheck`.
- [ ] **Step 5: Commit**

```bash
git add b4m-core/services/src/llm/tools/implementation/videoGeneration
git commit -m "feat(video): build the agent tool schema from model capabilities"
```

---

### Task 3: Tool definition and every registration surface

**Files:**
- Create: `.../videoGeneration/index.ts`, `.../videoGeneration/videoGeneration.test.ts`
- Modify: `b4m-core/common/src/schemas/llm.ts`, `b4m-core/common/src/schemas/toolSideEffects.ts`, `b4m-core/services/src/llm/tools/index.ts`, `b4m-core/services/src/llm/tools/ToolBuilder.ts` (comment only), `apps/client/app/utils/toolMapping.ts`, `apps/client/app/constants/tools.tsx`, `apps/client/app/components/Session/AISettings/ToolsSection.tsx`
- Test: `toolSideEffects.test.ts` (existing, must stay green), `ToolsSection.gating.test.tsx`

**Interfaces:**
- Consumes: `buildVideoToolSchema` (Task 2); `CreateVideoJobInput`, `CreateVideoJobResult` from `b4m-core/services/src/videoJobs/types.ts`.
- Produces:

```ts
export type VideoToolConfig = {
  usableModels: readonly VideoModelId[];
  createJob: (input: CreateVideoJobInput) => Promise<CreateVideoJobResult>;
};
export const isVideoToolConfig: (value: unknown) => value is VideoToolConfig & { usableModels: readonly [VideoModelId, ...VideoModelId[]] };
export const videoGenerationTool: ToolDefinition;
```

Success result string: `JSON.stringify({ jobId, estimatedSeconds })`, where `estimatedSeconds` is the chosen model's `typicalRenderSeconds`. On `ok:false`: `Video generation failed (${code}): ${message}` returned as a string (never thrown), no `statusUpdate`. On success, `await context.statusUpdate({ videoJobIds: [job.id] })`.

- [ ] **Step 1: Failing tests** (`videoGeneration.test.ts`):

```ts
import { describe, expect, it, vi } from 'vitest';
import { videoGenerationTool, isVideoToolConfig, type VideoToolConfig } from './index';

const okJob = { ok: true as const, created: true, job: { id: 'job1' } };

const build = (createJob: VideoToolConfig['createJob'], questId: string | undefined = 'q1') => {
  const statusUpdate = vi.fn().mockResolvedValue(undefined);
  const config: VideoToolConfig = { usableModels: ['test-video'], createJob };
  const context = { userId: 'u1', organizationId: null, questId, statusUpdate } as never;
  return { tool: videoGenerationTool.implementation(context, config), statusUpdate };
};

describe('video_generation tool', () => {
  it('starts an agent-sourced job and returns the job id with an estimate', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-video', prompt: 'a cat' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 8 });
    expect(createJob.mock.calls[0][0]).toMatchObject({ source: 'agent', questId: 'q1', user: { id: 'u1' } });
    expect(statusUpdate).toHaveBeenCalledWith({ videoJobIds: ['job1'] });
  });

  it('sends image-to-video when an input image id is given', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-video', prompt: 'x', inputImageFileId: 'f1' });
    expect(createJob.mock.calls[0][0].request).toMatchObject({ mode: 'image_to_video', inputImageFileId: 'f1' });
  });

  it('returns a readable error and records no job', async () => {
    const createJob = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 402, code: 'insufficient_credits', message: 'Not enough credits' });
    const { tool, statusUpdate } = build(createJob);
    const text = await tool.toolFn({ model: 'test-video', prompt: 'x' });
    expect(text).toContain('insufficient_credits');
    expect(text).toContain('Not enough credits');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('derives a stable idempotency key per quest and request', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-video', prompt: 'a' });
    await tool.toolFn({ model: 'test-video', prompt: 'a' });
    await tool.toolFn({ model: 'test-video', prompt: 'b' });
    const keys = createJob.mock.calls.map(call => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).toMatch(/^agent:u1:q1:[0-9a-f]{32}$/);
  });

  it('omits the key without a quest', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob, undefined);
    await tool.toolFn({ model: 'test-video', prompt: 'a' });
    expect(createJob.mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  it('isVideoToolConfig rejects empty and malformed configs', () => {
    expect(isVideoToolConfig(undefined)).toBe(false);
    expect(isVideoToolConfig({ usableModels: [], createJob: vi.fn() })).toBe(false);
    expect(isVideoToolConfig({ usableModels: ['test-video'], createJob: vi.fn() })).toBe(true);
  });
});
```

- [ ] **Step 2:** run -> FAIL (module missing).
- [ ] **Step 3: Implement.** `videoGeneration/index.ts`:

```ts
import { createHash } from 'node:crypto';
import { VIDEO_MODEL_CATALOG, type VideoModelId } from '@bike4mind/common';
import type { CreateVideoJobInput, CreateVideoJobResult } from '../../../videoJobs/types';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildVideoToolSchema, type VideoToolArgs } from './buildSchema';

export type VideoToolConfig = {
  usableModels: readonly VideoModelId[];
  createJob: (input: CreateVideoJobInput) => Promise<CreateVideoJobResult>;
};

type PopulatedVideoToolConfig = VideoToolConfig & { usableModels: readonly [VideoModelId, ...VideoModelId[]] };

export const isVideoToolConfig = (value: unknown): value is PopulatedVideoToolConfig =>
  typeof value === 'object' &&
  value !== null &&
  'createJob' in value &&
  typeof value.createJob === 'function' &&
  'usableModels' in value &&
  Array.isArray(value.usableModels) &&
  value.usableModels.length > 0;

// ToolContext carries no tool call id, so identical calls within one turn collapse to one job by design.
const buildIdempotencyKey = (userId: string, questId: string | undefined, request: unknown): string | undefined => {
  if (!questId) return undefined;
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 32);
  return `agent:${userId}:${questId}:${digest}`;
};

const toRequest = (args: VideoToolArgs) => {
  const caps = VIDEO_MODEL_CATALOG[args.model];
  return {
    model: args.model,
    mode: args.inputImageFileId ? 'image_to_video' : 'text_to_video',
    prompt: args.prompt,
    durationSeconds: args.durationSeconds ?? caps.defaults.durationSeconds,
    aspectRatio: args.aspectRatio ?? caps.defaults.aspectRatio,
    resolution: args.resolution ?? caps.defaults.resolution,
    ...(args.inputImageFileId ? { inputImageFileId: args.inputImageFileId } : {}),
  };
};

export const videoGenerationTool: ToolDefinition = {
  name: 'video_generation',
  implementation: (context: ToolContext, config?: unknown) => {
    if (!isVideoToolConfig(config)) throw new Error('video_generation requires a VideoToolConfig');
    const { schema, description } = buildVideoToolSchema(config.usableModels);
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        const request = toRequest(args);
        const result = await config.createJob({
          user: { id: context.userId, organizationId: context.organizationId ?? null },
          request,
          source: 'agent',
          questId: context.questId,
          idempotencyKey: buildIdempotencyKey(context.userId, context.questId, request),
        });
        if (!result.ok) return `Video generation failed (${result.code}): ${result.message}`;
        await context.statusUpdate({ videoJobIds: [result.job.id] });
        return JSON.stringify({
          jobId: result.job.id,
          estimatedSeconds: VIDEO_MODEL_CATALOG[args.model].typicalRenderSeconds,
        });
      },
      toolSchema: { name: 'video_generation', description, parameters: schema },
    };
  },
};
```

Before writing, read the `toolSchema` literal in `imageGeneration/index.ts` and the `ToolContext`/`ToolDefinition` types in `base/types.ts`, and match the exact shape (how `parameters` is expressed, whether `config` is typed `unknown`, `organizationId` optionality). Adjust only the literal shape, never the behavior the tests assert. `videoJobIds` on `statusUpdate`'s `Partial<IChatHistoryItemDocument>` requires the Task 5 entity field; if the typecheck complains, add the one-line `videoJobIds?: string[]` to `SessionTypes.ts` in this commit and let Task 5 cover the rest.

Registration, all in this commit:
  - `schemas/llm.ts`: add `'video_generation'` to the `b4mLLMTools` enum.
  - `schemas/toolSideEffects.ts`: add `video_generation: 'external'` to `CORE_TOOL_SIDE_EFFECTS` and delete it from `EXTERNAL_REGISTRY_SIDE_EFFECTS` (line ~134).
  - `tools/index.ts`: `video_generation: videoGenerationTool,` in `b4mTools`, plus re-export `VideoToolConfig` and `isVideoToolConfig` so `@bike4mind/services` exposes them.
  - `ToolBuilder.ts` billing branches (~884, ~949): add the comment `// video_generation bills in createVideoJob, not here.`
  - `toolMapping.ts` and `constants/tools.tsx`: a `video_generation` entry (label `Video Generation`), mirroring the field set of the `image_generation` entry.
  - `ToolsSection.tsx`: add `video_generation` to `MISSING_KEY_TOOLTIPS` (73-86) with `No video model is available. Ask an admin to enable one.` and a row mirroring `image_generation`'s.
  - `ToolsSection.gating.test.tsx`: add a case asserting the `tool-item-video-generation` row renders.
- [ ] **Step 4:** run `videoGeneration.test.ts`, `toolSideEffects.test.ts`, `ToolsSection.gating.test.tsx` (jsdom) -> PASS; then `pnpm turbo:core:build && pnpm turbo:typecheck` via `verify`.
- [ ] **Step 5: Commit**

```bash
git add b4m-core apps/client/app
git commit -m "feat(video): add the video_generation agent tool"
```

---

### Task 4: Central gate, injection param and safe resolver

**Files:**
- Create: `b4m-core/services/src/llm/resolveVideoToolConfigSafely.ts` (+ `.test.ts`), `b4m-core/services/src/llm/sharedToolBuilder.videoGate.test.ts`
- Modify: `b4m-core/services/src/llm/sharedToolBuilder.ts` (config map ~372, availability ~392/~410), `b4m-core/services/src/llm/ChatCompletionProcess.ts` (process params ~1704, `buildTools` config ~3050-3098)

**Interfaces:**
- Consumes: `VideoToolConfig`, `isVideoToolConfig` (Task 3).
- Produces: `resolveVideoToolConfigSafely(resolve: (() => Promise<VideoToolConfig | null>) | undefined, logger: Logger): Promise<VideoToolConfig | null>`; `process({ ..., videoToolConfigResolver?: () => Promise<VideoToolConfig | null> })`.

- [ ] **Step 1: Failing tests.**

`resolveVideoToolConfigSafely.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { resolveVideoToolConfigSafely } from './resolveVideoToolConfigSafely';

describe('resolveVideoToolConfigSafely', () => {
  it('returns null without a resolver', async () => {
    expect(await resolveVideoToolConfigSafely(undefined, { warn: vi.fn() } as never)).toBeNull();
  });

  it('returns the resolved config', async () => {
    const config = { usableModels: ['test-video'], createJob: vi.fn() };
    expect(await resolveVideoToolConfigSafely(async () => config as never, { warn: vi.fn() } as never)).toBe(config);
  });

  it('degrades to null and warns when the resolver throws', async () => {
    const warn = vi.fn();
    const result = await resolveVideoToolConfigSafely(
      async () => {
        throw new Error('db down');
      },
      { warn } as never
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
```

`sharedToolBuilder.videoGate.test.ts`: copy the minimal `buildSharedTools` invocation from the nearest existing `sharedToolBuilder*.test.ts` (read it first for the required params), with `enabledTools: ['video_generation']`, and assert the result contains a tool named `video_generation` when `config.video_generation` is a populated config, and does not when `usableModels: []`, when the config is `undefined`, and when `toolAvailability: { video_generation: true }` is set but no config is passed.

- [ ] **Step 2:** run -> FAIL.
- [ ] **Step 3: Implement.** `resolveVideoToolConfigSafely.ts`:

```ts
import type { Logger } from '@bike4mind/observability';
import type { VideoToolConfig } from './tools/implementation/videoGeneration';

export async function resolveVideoToolConfigSafely(
  resolve: (() => Promise<VideoToolConfig | null>) | undefined,
  logger: Logger
): Promise<VideoToolConfig | null> {
  if (!resolve) return null;
  try {
    return await resolve();
  } catch (error) {
    logger.warn('video_generation unavailable: capability resolution failed', error);
    return null;
  }
}
```

`sharedToolBuilder.ts`: add `video_generation: config.video_generation` to the per-tool config map next to `image_generation`, and before `isToolOfferable` is evaluated build

```ts
const effectiveAvailability = { ...toolAvailability, video_generation: isVideoToolConfig(config.video_generation) };
```

then use `effectiveAvailability` at both call sites (~392, ~410). Read `toolAvailability.ts` first: add `video_generation` to `GATED_TOOLS` only if `isToolOfferable` needs membership to honor an explicit `false`.

`ChatCompletionProcess.ts`: add `videoToolConfigResolver` to the `process` params type and destructuring and import `resolveVideoToolConfigSafely`. Resolve lazily near the `resolveToolAvailability` call (~1957):

```ts
const videoToolConfig = enabledTools.includes('video_generation')
  ? await resolveVideoToolConfigSafely(videoToolConfigResolver, logger)
  : null;
```

and pass `video_generation: videoToolConfig ?? undefined` in the `buildTools` `config` object (~3050-3098). Use the real local name for the enabled-tool list found in the surrounding code.
- [ ] **Step 4:** run both new tests, the existing `sharedToolBuilder` tests and `pnpm --filter @bike4mind/services typecheck` -> PASS.
- [ ] **Step 5: Commit**

```bash
git add b4m-core/services/src/llm
git commit -m "feat(video): gate the video tool on an injected capability"
```

---

### Task 5: videoJobIds on the quest, end to end

**Files:**
- Modify: `b4m-core/common/src/types/entities/SessionTypes.ts` (next to `images`/`videos`, ~192-195), `b4m-core/common/src/schemas/actions.ts` (~374), `packages/database/src/models/content/QuestModel.ts` (schema ~583, projections ~1121 and ~1270, view types ~1555/1569), `b4m-core/services/src/llm/tools/ToolBuilder.ts` (`applyQuestStatusChanges`), `b4m-core/services/src/llm/StatusManager.ts` (~138-180), `apps/client/server/chatCompletion/questTimeoutRecovery.ts` (67, 92, 131)
- Test: the existing `applyQuestStatusChanges` test file (locate with grep), `StatusManager.test.ts`, a `QuestModel` `__tests__` file (use `createMongoServer()`), `questTimeoutRecovery.test.ts`

**Interfaces:**
- Produces: quest field `videoJobIds?: string[]` in the entity type, the actions Zod schema and the Mongoose schema (a field in only one is silently dropped).

- [ ] **Step 1: Failing tests.**
  - `applyQuestStatusChanges`: with `quest.videoJobIds = ['a']` and changes `{ videoJobIds: ['a', 'b'] }` the result is `['a','b']` (dedupe, order kept); with no prior field the result is `['b']` for `{ videoJobIds: ['b'] }`.
  - `StatusManager`: the minimal payload for a quest with `videoJobIds: ['a']` contains `videoJobIds: ['a']` (mirror the existing `images` assertion).
  - `QuestModel`: save a quest with `videoJobIds: ['a']`, reload through each projection helper that returns `images`, assert the ids come back (mirror the existing `images` round-trip test).
  - `questTimeoutRecovery`: a recovered quest keeps its `videoJobIds` (mirror the `images` assertion).
- [ ] **Step 2:** run each -> FAIL.
- [ ] **Step 3: Implement.**
  - `SessionTypes.ts`: `videoJobIds?: string[];` beside `videos`, with the comment `// Generation job ids rendered as VideoJobCards; distinct from the legacy videos urls.`
  - `actions.ts`: `videoJobIds: z.array(z.string()).optional(),` next to the `videos` entry.
  - `QuestModel.ts`: `videoJobIds: { type: [String], default: undefined }` beside `videos`; add `videoJobIds` to every projection and view type that lists `images`.
  - `applyQuestStatusChanges`: destructure `videoJobIds: changedVideoJobIds` with the other changes and add

```ts
  if (changedVideoJobIds) {
    quest.videoJobIds = [...new Set([...(quest.videoJobIds ?? []), ...changedVideoJobIds])];
  }
```

  - `StatusManager.createOptimizedPayload`: carry `videoJobIds` wherever `images` is carried.
  - `questTimeoutRecovery.ts`: carry `videoJobIds` at lines 67, 92, 131 alongside `images`.
- [ ] **Step 4:** run the four test files; `pnpm turbo:core:build`, then `verify` for typecheck.
- [ ] **Step 5: Commit**

```bash
git add b4m-core packages/database apps/client/server
git commit -m "feat(video): persist video job ids on the quest"
```

---

### Task 6: App-side capability and questProcessor wiring

**Files:**
- Create: `apps/client/server/videoGenerations/buildVideoToolConfig.ts`, `.../buildVideoToolConfig.test.ts`
- Modify: `apps/client/server/queueHandlers/questProcessor.ts` (the `chatCompletion.process({ body: requestBody, logger, externalTools })` call, ~331)

**Interfaces:**
- Consumes: `listUsableVideoModels(userId, deps)` (returns `VideoModel[]` with `id`) and `VideoModelAvailabilityDeps` from `listUsableVideoModels.ts`; `getCreateVideoJobDeps()` and `getVideoJobDeps()` from `apps/client/server/generationJobs/wiring.ts`; `createVideoJob` and `CreateVideoJobDeps` from `@bike4mind/services/videoJobs`.
- Produces: `buildVideoToolConfig(userId: string, deps: { availability: VideoModelAvailabilityDeps; createDeps: CreateVideoJobDeps }): Promise<VideoToolConfig | null>`; `null` when no model is usable.

- [ ] **Step 1: Failing tests** (project `node`, it lives under `server/`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./listUsableVideoModels', () => ({ listUsableVideoModels: vi.fn() }));

import { buildVideoToolConfig } from './buildVideoToolConfig';
import { listUsableVideoModels } from './listUsableVideoModels';

const deps = { availability: {} as never, createDeps: {} as never };

describe('buildVideoToolConfig', () => {
  beforeEach(() => vi.mocked(listUsableVideoModels).mockReset());

  it('returns null when no model is usable', async () => {
    vi.mocked(listUsableVideoModels).mockResolvedValue([]);
    expect(await buildVideoToolConfig('u1', deps)).toBeNull();
  });

  it('exposes usable model ids and a createJob bound to the deps', async () => {
    vi.mocked(listUsableVideoModels).mockResolvedValue([{ id: 'test-video' }] as never);
    const config = await buildVideoToolConfig('u1', deps);
    expect(config?.usableModels).toEqual(['test-video']);
    expect(typeof config?.createJob).toBe('function');
  });
});
```

- [ ] **Step 2:** run -> FAIL.
- [ ] **Step 3: Implement.**

```ts
import { createVideoJob, type CreateVideoJobDeps } from '@bike4mind/services/videoJobs';
import type { VideoToolConfig } from '@bike4mind/services';
import { listUsableVideoModels, type VideoModelAvailabilityDeps } from './listUsableVideoModels';

export async function buildVideoToolConfig(
  userId: string,
  deps: { availability: VideoModelAvailabilityDeps; createDeps: CreateVideoJobDeps }
): Promise<VideoToolConfig | null> {
  const usable = await listUsableVideoModels(userId, deps.availability);
  if (usable.length === 0) return null;
  return {
    usableModels: usable.map(model => model.id),
    createJob: input => createVideoJob(input, deps.createDeps),
  };
}
```

Confirm `VideoToolConfig` is reachable from the `@bike4mind/services` root (Task 3 re-export) and `VideoModel.id` is `VideoModelId`. In `questProcessor.ts` add to the `process` call (use the user id variable already in scope there):

```ts
videoToolConfigResolver: () =>
  buildVideoToolConfig(userId, { availability: getVideoJobDeps(), createDeps: getCreateVideoJobDeps() }),
```

Confirm both helper signatures in `wiring.ts` first. For billing org, the tool passes `context.organizationId`; read `resolveBillingOrgId` in `pages/api/v1/video-generations/index.ts` and, if it applies rules beyond reading the quest's org, apply the same rule inside `createJob` here so agent and API jobs bill the same owner.
- [ ] **Step 4:** run the new test and existing `questProcessor` tests (project `node`) -> PASS; `verify` typecheck.
- [ ] **Step 5: Commit**

```bash
git add apps/client/server
git commit -m "feat(video): wire the video capability into chat completion"
```

---

### Task 7: Infra for the ChatCompletion service

**Files:**
- Modify: `infra/chatCompletion.ts` (link list and environment)
- Reference: `infra/constants.ts` (`TEST_VIDEO_PROVIDER_ENVIRONMENT`), `infra/queues.ts` (`generationJobQueue`), `infra/web.ts` (how `web` links the queue and sets the env)

- [ ] **Step 1:** In `infra/web.ts` find how `generationJobQueue` is linked and `TEST_VIDEO_PROVIDER_ENVIRONMENT` is spread; copy that exact form.
- [ ] **Step 2:** In `infra/chatCompletion.ts` add `generationJobQueue` to the service `link` array and spread `...TEST_VIDEO_PROVIDER_ENVIRONMENT` into its `environment`, with the imports.
- [ ] **Step 3:** Typecheck infra (`pnpm turbo:typecheck` via `verify`) and run any infra parity test (grep `infra` for `*.test.ts` covering link or environment parity).
- [ ] **Step 4: Commit**

```bash
git add infra/chatCompletion.ts
git commit -m "chore(infra): let chat completion enqueue video jobs"
```

---

### Task 8: One VideoJobCard per job id in the reply

**Files:**
- Create: `apps/client/app/components/Session/GeneratedVideoJobs.tsx`, `GeneratedVideoJobs.test.tsx`
- Modify: `apps/client/app/components/Session/hooks/useStreamingMessageMerge.ts` (lines 93, 116), `Session/types/UserPromptTypes.ts`, `Session/PromptReplies.tsx` (reply block next to the `videos` block ~1695-1720, and the render condition ~1575)
- Test: `useStreamingMessageMerge.test.ts` (extend)

**Interfaces:**
- Consumes: `VideoJobCard` default export from `../VideoStudio/VideoJobCard` (props `{ jobId: string }`).
- Produces: `GeneratedVideoJobs: FC<{ jobIds: readonly string[] | undefined }>` rendering `data-testid="generated-video-jobs-list"` with one card per id.

- [ ] **Step 1: Failing tests.**
  - `GeneratedVideoJobs.test.tsx` (jsdom, Joy wrapper per Global Constraints; `vi.mock('../VideoStudio/VideoJobCard', () => ({ default: ({ jobId }: { jobId: string }) => <div data-testid="video-job-card-stub">{jobId}</div> }))`): three ids render three stubs in order; `undefined` and `[]` render nothing.
  - `useStreamingMessageMerge.test.ts`: a streamed frame with `videoJobIds: ['a','b']` over a previous `['a']` yields `['a','b']`; a frame without the field keeps the previous value (fallback-replace, as the neighbouring fields at lines 93/116).
- [ ] **Step 2:** run -> FAIL.
- [ ] **Step 3: Implement.**

```tsx
import { Stack } from '@mui/joy';
import type { FC } from 'react';
import VideoJobCard from '../VideoStudio/VideoJobCard';

export const GeneratedVideoJobs: FC<{ jobIds: readonly string[] | undefined }> = ({ jobIds }) => {
  if (!jobIds?.length) return null;
  return (
    <Stack spacing={1} data-testid="generated-video-jobs-list">
      {jobIds.map(jobId => (
        <VideoJobCard key={jobId} jobId={jobId} />
      ))}
    </Stack>
  );
};
```

  - `UserPromptTypes.ts`: `videoJobIds?: string[]` on the reply type beside `videos`.
  - `useStreamingMessageMerge.ts`: add `videoJobIds: streamed.videoJobIds ?? previous.videoJobIds` in both places `videos` is merged, using the surrounding variable names.
  - `PromptReplies.tsx`: render `<GeneratedVideoJobs jobIds={reply.videoJobIds} />` directly above the legacy `videos` block, and extend the condition at ~1575 so a reply with only `videoJobIds` still renders its container.
- [ ] **Step 4:** run the two test files (jsdom) -> PASS; `verify` typecheck.
- [ ] **Step 5: Commit**

```bash
git add apps/client/app
git commit -m "feat(video): render a video job card per agent-started job"
```

---

### Task 9: Verification gate and preview E2E

**Files:** none (verification only; fix forward in the owning task's area if anything fails).

- [ ] **Step 1: Gate** via a `verify` subagent: `pnpm turbo:core:build && pnpm turbo:typecheck && pnpm turbo:test && pnpm lint:check`. Report only failing lines.
- [ ] **Step 2: ASCII scan** of added lines (the pre-commit hook runs `scripts/check-no-smart-punctuation.sh`; also run it over the branch's changed `.ts`/`.tsx` files).
- [ ] **Step 3: Overlay safety.** Grep the premium overlay checkouts (`/Users/onoya/dev/b4m-*`) for `video_generation` and `VideoToolConfig` before merge; only a preview run catches an overlay import break, so confirm the overlay preview check is green.
- [ ] **Step 4: Preview deploy** with the `preview` label (default; no staging). The preview needs `ENABLE_TEST_VIDEO_PROVIDER` (set on ChatCompletion by Task 7) and an admin setting enabling `test-video`. Previews have no platform OpenAI key, so choose a non-OpenAI chat model that supports tools.
- [ ] **Step 5: E2E checklist** (record results in the PR test guide):
  - [ ] Studio: generate a 5s `test-video` clip from text, then from an uploaded image; both succeed and play.
  - [ ] Chat, text: enable the Video Generation tool and ask for "a 4 second clip of waves". The reply shows a `VideoJobCard` that goes pending -> running -> done, and the model's text mentions the estimate.
  - [ ] Chat, image: upload an image, ask to animate it for 6 seconds. The card shows an image-to-video job and completes.
  - [ ] Duration bounds: 3s and 10s clips both start (acceptance range 3-10s). A 15s request is relayed as a validation message by the model and no card appears.
  - [ ] Reload mid-render: the card re-attaches and finishes.
  - [ ] Disable all video models in admin settings: the tool is not offered and a request for a video produces no tool call.
  - [ ] Credits: with credits enforced, a studio job and an agent job each hold and settle once; a duplicate same-turn call creates one job.
  - [ ] Agent mode (`allowedTools` untouched): the tool is available only when the user's Smart Tools include it.
- [ ] **Step 6:** Open the PR as a draft stacked on the phase 4 branch (a child PR stays draft until the parent merges).

---

## Out of scope

- Wiring `pages/api/chat.ts`, Slack and voice (they silently lack the tool via the Task 4 gate).
- Adding `video_generation` to the agent-mode `allowedTools`.
- Generated-image storage keys as the video input image.
- Exposing `typicalRenderSeconds` in the public API or UI.
- Per-model strict schema (discrete duration sets are enforced by `createVideoJob`, never clamped).
- The legacy quest `videos` field and `schemas/quest.ts`.
- Cancelling a job from the chat card.

## Spec coverage

| Requirement | Task |
|-------------|------|
| Schema generated from usable models' capabilities, image reference | 2, 3 |
| Non-blocking, `{ jobId, estimatedSeconds }` | 3 |
| Billing stays in the job engine, `source: 'agent'` | 3, 6 |
| `toolSideEffects` = `external`, in core | 3 |
| App-injected capability, gate on zero usable models | 4, 6 |
| Registration surfaces mirror `image_generation` | 3 |
| Quest `videoJobIds` | 5, 8 |
| Preview E2E, 3-10s text and image acceptance | 7, 9 |

## Self-review notes

- Type names are consistent across tasks: `VideoToolConfig`, `isVideoToolConfig`, `buildVideoToolSchema`, `VideoToolArgs`, `resolveVideoToolConfigSafely`, `videoToolConfigResolver`, `buildVideoToolConfig`, `GeneratedVideoJobs`, `videoJobIds`.
- Steps that say "read the surrounding code" name the exact file and symbol; those spots (config map, `toolSchema` literal, wiring helper signatures) must be aligned to the real literal shape without changing the behavior the tests assert.
- Open questions for the owner: (a) approve the args-hash idempotency key (it dedupes identical same-turn calls); (b) also wire `pages/api/chat.ts` and Slack; (c) confirm the `typicalRenderSeconds` values (test 8, gemini 90, grok 60, veo 90).
