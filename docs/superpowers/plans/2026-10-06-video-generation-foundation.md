# Video Generation Foundation (Plan 1 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-agnostic video-generation foundation (capability domain, durable generation-job engine, video job kind, deterministic test provider, queue + sweeper + self-host wiring) so a video job runs end to end against the test provider. No user-facing surface yet.

**Architecture:** Capability declarations are pure data in `@bike4mind/common` (`src/video/`), shared by server and client. Provider adapters implement a bounded `VideoProvider` interface in `@bike4mind/utils` (`src/videoProviders/`). A generic `GenerationJobEngine` in `@bike4mind/services` (`src/generationJobs/`) advances a `GenerationJob` Mongo document one step per SQS message, with leases, delayed re-polls, a deadline, a sweeper and cancel. The `video` kind (`src/videoJobs/`) plugs into the engine and owns validation, credit holds, storage and the Files copy.

**Tech Stack:** TypeScript (strict), Zod v4, Mongoose, vitest, SST v3 (`sst.aws.Queue`, `sst.aws.Cron`), AWS SQS (`DelaySeconds`), ElasticMQ for self-host.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-provider-video-generation-design.md`. Issue #3890.

## Global Constraints

- ASCII only in every added `.ts`/`.tsx` line (pre-commit `check-no-smart-punctuation.sh` / `check-no-control-bytes.sh`). Use `'\u2014'` escapes if a typographic char is genuinely needed.
- Never `any`; use `unknown` + narrowing, generics, or Zod-inferred types. Prefer `type` over `interface` except where the repo convention is `interface` (repository interfaces, `I*Document`).
- No `index: true` on fields; all performance indexes declared together at the bottom of the schema via `schema.index()`; a new index ships with an ensure-index migration.
- Database tests use `setupMongoTest()` (which uses `createMongoServer()`) and call `GenerationJobModel.ensureIndexes()` in `beforeEach`.
- Comments explain *why*, never restate code. Cross-reference comments ("must stay in sync with X") are encouraged.
- Conventional Commits; no tracker numbers, customer names or cloud identifiers in code, comments or commits. Never hand-write a Co-Authored-By trailer.
- Do not add dependencies to the root `package.json`.
- After changing `@bike4mind/common`, run `pnpm turbo:core:build` before running tests in packages that import it (cross-package tests read `dist`).
- Credit movement happens in exactly one place: the `creditService/creditHold.ts` functions from Task 3.
- Video job constants (copy verbatim): poll backoff `[5, 10, 20, 30, 60]` seconds then 60 capped; video `maxWallClockMs = 20 * 60_000`; `MAX_STEP_ATTEMPTS = 5`; sweeper every 5 minutes, overdue cutoff 5 minutes; `MAX_VIDEO_OUTPUT_BYTES = 256 * 1024 * 1024`; `MAX_INLINE_PROVIDER_OUTPUT_BYTES = 1024 * 1024`; worker Lambda timeout 5 minutes, memory 2048 MB, visibility timeout 6 minutes; lease = handler timeout + 30s = 330 seconds.

## Review Focus

1. **Duplicate or reordered SQS delivery of the same `{ jobId }`** - two workers must never run the same step; the second must exit without side effects (pinned in Task 5 repo test "a second acquireLease while leased returns null" and Task 6 engine test "duplicate message while leased is a no-op").
2. **A step for a job whose terminal state was committed but whose `onTerminal` (credit settle/release) crashed** - credits must be settled or released at most once, and the sweeper must pick the job back up (Task 6 tests "re-runs onTerminal for a terminal job left unhandled" and "onTerminal is never run twice"; Task 5 repo test for `claimTerminalHandling`).
3. **A request that passes Zod but not the model's capabilities** (e.g. 12s on a 1-10s model, `9:16` on a 16:9-only model, image-to-video without an input image) - must fail with the specific code before any credit hold (Task 1 validation tests; Task 8 test "invalid request holds no credits").
4. **Files copy refused because the user is over storage quota** - the job must still succeed with `output.location === 'generated'` and the user is charged for a video they can retrieve (Task 8 test "falls back to the generated bucket when Files refuses").
5. **Job created but enqueue fails** (SQS outage at create time) - the hold must be released and the job must not be left pending forever (Task 8 test "releases the hold and fails the job when enqueue throws"; sweeper covers a lost message after enqueue succeeded).

---

## PR boundaries

- **PR 1a (Tasks 1-4):** `feat(video): add the video capability domain, media-only file guard and credit holds`. Pure groundwork, no runtime change except `reserveRequestCredits` now delegating (behaviour preserved, its 7 existing tests must stay green).
- **PR 1b (Tasks 5-10):** `feat(video): add the generation-job engine and video job kind`. Depends on PR 1a; open it as a draft stacked on 1a until 1a merges.

## File Structure

| File | Responsibility |
|---|---|
| `b4m-core/common/src/video/types.ts` | Mode / aspect / resolution / provider const arrays, `VideoModelCapabilities` type |
| `b4m-core/common/src/video/catalog.ts` | `VIDEO_MODEL_IDS`, `VIDEO_MODEL_CATALOG` (declared data), `getVideoModelCapabilities` |
| `b4m-core/common/src/video/request.ts` | `VideoGenerationRequestSchema`, `VideoGenerationRequest` |
| `b4m-core/common/src/video/validate.ts` | `validateAgainstCapabilities`, error codes |
| `b4m-core/common/src/video/estimateCost.ts` | `estimateVideoCostUsd`, `estimateVideoCostCredits` |
| `b4m-core/common/src/video/limits.ts` | byte limits |
| `b4m-core/common/src/video/index.ts` | barrel |
| `b4m-core/common/src/types/common.ts` | `isVideoMimeType`, `isMediaOnlyMimeType`, storable gate |
| `b4m-core/common/src/types/entities/FabFileTypes.ts` | `KnowledgeType.VIDEO` |
| `b4m-core/services/src/creditService/creditHold.ts` | `holdCredits`, `settleCreditHold`, `releaseCreditHold`, `CreditHold`, `CreditLedgerEntry` |
| `apps/client/server/billing/reserveRequestCredits.ts` | rewritten on top of `creditHold.ts` |
| `b4m-core/utils/src/videoProviders/types.ts` | `VideoProvider` interface and result unions, `ProviderSubmitError` |
| `b4m-core/utils/src/videoProviders/registry.ts` | `createVideoProviderRegistry` |
| `b4m-core/utils/src/videoProviders/test/TestVideoProvider.ts` | deterministic provider |
| `b4m-core/utils/src/videoProviders/test/fixtureVideo.ts` | generated base64 MP4 fixture |
| `b4m-core/common/src/types/entities/GenerationJobTypes.ts` | job entity, states, repository interface |
| `packages/database/src/models/ai/GenerationJobModel.ts` | schema, indexes, repository |
| `packages/scripts/migrate/migrations/20260923000000_ensure-generation-job-indexes.ts` | ensure indexes |
| `b4m-core/services/src/generationJobs/{types,backoff,engine,sweep,index}.ts` | generic engine |
| `b4m-core/common/src/schemas/actions.ts` | `generation_job_updated` websocket action |
| `b4m-core/common/src/schemas/settings.ts` | `videoGeneration` admin setting |
| `b4m-core/services/src/videoJobs/{createVideoJob,videoJobHandler,types,index}.ts` | video kind |
| `apps/client/server/generationJobs/wiring.ts` | production wiring (repos, providers, storage, enqueue, notifier) |
| `apps/client/server/queueHandlers/generationJob.ts` | SQS handler |
| `apps/workers/src/cron/generationJobSweep.ts` + `apps/workers/src/selfhost/generationJobSweep.ts` | sweeper |
| `infra/queues.ts`, `infra/web.ts`, `infra/dlqAlarms.ts`, `infra/logMonitor.ts`, `infra/cron.ts`, `apps/client/server/utils/dlqRegistry.ts`, `elasticmq.conf`, `.env.selfhost.example`, `b4m-core/resource/src/manifest.ts`, `apps/workers/src/selfhost/main.ts` | wiring |

Why `video/` and `videoProviders/` and `videoJobs/` rather than `videoGeneration/`: `b4m-core/common/src/videoGeneration.ts`, `b4m-core/utils/src/videoGeneration/` and `b4m-core/services/src/llm/VideoGeneration.ts` are the Sora pipeline, deleted in plan 2. New names avoid module-resolution collisions while both exist.

---

### Task 1: Video capability domain (common)

**Files:**
- Create: `b4m-core/common/src/video/types.ts`, `catalog.ts`, `request.ts`, `validate.ts`, `estimateCost.ts`, `limits.ts`, `index.ts`
- Create: `b4m-core/common/src/video/validate.test.ts`, `estimateCost.test.ts`, `catalog.test.ts`
- Modify: `b4m-core/common/src/index.ts` (add `export * from './video';`)

**Interfaces:**
- Consumes: `usdToCredits` from `b4m-core/common/src/pricing.ts`.
- Produces (used by Tasks 4, 7, 8 and plans 2-5):
  - `VIDEO_MODES`, `VideoMode`, `ASPECT_RATIOS`, `AspectRatio`, `RESOLUTION_TIERS`, `ResolutionTier`, `VIDEO_PROVIDER_IDS`, `VideoProviderId`
  - `VideoModelCapabilities`, `DurationCapability`, `VideoPricing`
  - `VIDEO_MODEL_IDS`, `VideoModelId`, `VideoModelIdSchema`, `VIDEO_MODEL_CATALOG: Record<VideoModelId, VideoModelCapabilities>`, `getVideoModelCapabilities(id: VideoModelId): VideoModelCapabilities`
  - `VideoGenerationRequestSchema`, `VideoGenerationRequest`, `ValidatedVideoRequest`
  - `validateAgainstCapabilities(request: VideoGenerationRequest, caps: VideoModelCapabilities): VideoValidationResult`
  - `VIDEO_VALIDATION_ERROR_CODES`, `VideoValidationErrorCode`
  - `estimateVideoCostUsd(caps, request): number`, `estimateVideoCostCredits(caps, request): number`
  - `MAX_VIDEO_OUTPUT_BYTES`, `MAX_INLINE_PROVIDER_OUTPUT_BYTES`

- [ ] **Step 1: Write the types and catalog**

`b4m-core/common/src/video/types.ts`:

```ts
export const VIDEO_MODES = ['text_to_video', 'image_to_video'] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTION_TIERS = ['360p', '480p', '720p', '1080p', '4k'] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

// Each provider adapter PR appends its id here (plan 2: 'gemini-omni', plan 3: 'veo', 'xai').
export const VIDEO_PROVIDER_IDS = ['test'] as const;
export type VideoProviderId = (typeof VIDEO_PROVIDER_IDS)[number];

export type DurationCapability =
  | { kind: 'range'; min: number; max: number; step: number }
  | { kind: 'discrete'; values: readonly number[] };

export type VideoPricing =
  | { unit: 'per_second'; usdByResolution: Partial<Record<ResolutionTier, number>> }
  | {
      unit: 'per_clip';
      clips: ReadonlyArray<{ durationSeconds: number; resolution: ResolutionTier; usd: number }>;
    };

export type VideoModelCapabilities = {
  provider: VideoProviderId;
  displayName: string;
  modes: readonly VideoMode[];
  duration: DurationCapability;
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly ResolutionTier[];
  defaults: { durationSeconds: number; aspectRatio: AspectRatio; resolution: ResolutionTier };
  audio: 'always' | 'optional' | 'none';
  pricing: VideoPricing;
  // Admin setting `videoGeneration.enabledModels[id]` overrides this.
  defaultEnabled: boolean;
  deprecationDate?: string;
};
```

`b4m-core/common/src/video/catalog.ts`:

```ts
import { z } from 'zod';
import type { VideoModelCapabilities } from './types';

// Adding a model: append its id here, then TypeScript forces a declaration in VIDEO_MODEL_CATALOG.
export const VIDEO_MODEL_IDS = ['test-video'] as const;
export type VideoModelId = (typeof VIDEO_MODEL_IDS)[number];
export const VideoModelIdSchema = z.enum(VIDEO_MODEL_IDS);

export const VIDEO_MODEL_CATALOG: Record<VideoModelId, VideoModelCapabilities> = {
  // Deterministic, free, registered only when ENABLE_TEST_VIDEO_PROVIDER=true (never in production).
  'test-video': {
    provider: 'test',
    displayName: 'Test video (non-production)',
    modes: ['text_to_video', 'image_to_video'],
    duration: { kind: 'range', min: 1, max: 10, step: 1 },
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p'],
    defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
    audio: 'none',
    pricing: { unit: 'per_second', usdByResolution: { '720p': 0.01 } },
    defaultEnabled: true,
  },
};

export const getVideoModelCapabilities = (id: VideoModelId): VideoModelCapabilities => VIDEO_MODEL_CATALOG[id];
```

`b4m-core/common/src/video/limits.ts`:

```ts
// A 10s 4k clip is well under this; anything larger is a provider anomaly, not a video we keep.
export const MAX_VIDEO_OUTPUT_BYTES = 256 * 1024 * 1024;
// Inline provider output is persisted on the job document between the poll and store steps.
export const MAX_INLINE_PROVIDER_OUTPUT_BYTES = 1024 * 1024;
```

`b4m-core/common/src/video/request.ts`:

```ts
import { z } from 'zod';
import { VideoModelIdSchema } from './catalog';
import { ASPECT_RATIOS, RESOLUTION_TIERS, VIDEO_MODES } from './types';

export const VideoGenerationRequestSchema = z.object({
  model: VideoModelIdSchema,
  mode: z.enum(VIDEO_MODES),
  prompt: z.string().trim().min(1).max(4000),
  durationSeconds: z.number().positive(),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolution: z.enum(RESOLUTION_TIERS),
  inputImageFileId: z.string().min(1).optional(),
  audio: z.boolean().optional(),
});
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

declare const validatedBrand: unique symbol;
// Only validateAgainstCapabilities produces this, so a provider can never receive an unchecked request.
export type ValidatedVideoRequest = VideoGenerationRequest & { readonly [validatedBrand]: true };
```

- [ ] **Step 2: Write the failing validation tests**

`b4m-core/common/src/video/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { VideoModelCapabilities } from './types';
import type { VideoGenerationRequest } from './request';
import { validateAgainstCapabilities } from './validate';

const rangeCaps: VideoModelCapabilities = {
  provider: 'test',
  displayName: 'Range',
  modes: ['text_to_video', 'image_to_video'],
  duration: { kind: 'range', min: 3, max: 10, step: 1 },
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['720p', '1080p'],
  defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
  audio: 'optional',
  pricing: { unit: 'per_second', usdByResolution: { '720p': 0.1, '1080p': 0.2 } },
  defaultEnabled: true,
};
const discreteCaps: VideoModelCapabilities = {
  ...rangeCaps,
  modes: ['text_to_video'],
  duration: { kind: 'discrete', values: [4, 6, 8] },
  audio: 'always',
};
const base: VideoGenerationRequest = {
  model: 'test-video',
  mode: 'text_to_video',
  prompt: 'a red bicycle',
  durationSeconds: 5,
  aspectRatio: '16:9',
  resolution: '720p',
};

describe('validateAgainstCapabilities', () => {
  it('accepts a request inside every capability', () => {
    expect(validateAgainstCapabilities(base, rangeCaps)).toMatchObject({ ok: true });
  });

  it.each([2, 11, 3.5])('rejects duration %s on a 3-10s step-1 range', durationSeconds => {
    expect(validateAgainstCapabilities({ ...base, durationSeconds }, rangeCaps)).toEqual({
      ok: false,
      code: 'unsupported_duration',
      message: expect.stringContaining('3-10'),
    });
  });

  it('rejects a duration outside the discrete set and names the allowed values', () => {
    expect(validateAgainstCapabilities({ ...base, durationSeconds: 5 }, discreteCaps)).toEqual({
      ok: false,
      code: 'unsupported_duration',
      message: expect.stringContaining('4, 6, 8'),
    });
  });

  it('rejects an aspect ratio the model does not declare', () => {
    expect(validateAgainstCapabilities({ ...base, aspectRatio: '1:1' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'unsupported_aspect_ratio',
    });
  });

  it('rejects a resolution the model does not declare', () => {
    expect(validateAgainstCapabilities({ ...base, resolution: '4k' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'unsupported_resolution',
    });
  });

  it('rejects a mode the model does not declare', () => {
    expect(
      validateAgainstCapabilities({ ...base, mode: 'image_to_video', inputImageFileId: 'f1' }, discreteCaps)
    ).toMatchObject({ ok: false, code: 'unsupported_mode' });
  });

  it('requires an input image for image_to_video', () => {
    expect(validateAgainstCapabilities({ ...base, mode: 'image_to_video' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'missing_input_image',
    });
  });

  it('rejects an input image on text_to_video rather than silently ignoring it', () => {
    expect(validateAgainstCapabilities({ ...base, inputImageFileId: 'f1' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'unexpected_input_image',
    });
  });

  it('rejects an audio toggle when the model does not make audio optional', () => {
    expect(validateAgainstCapabilities({ ...base, audio: false, durationSeconds: 4 }, discreteCaps)).toMatchObject({
      ok: false,
      code: 'unsupported_audio_option',
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @bike4mind/common exec vitest run src/video/validate.test.ts`
Expected: FAIL - `Cannot find module './validate'`.

- [ ] **Step 4: Implement `validate.ts`**

```ts
import type { VideoGenerationRequest, ValidatedVideoRequest } from './request';
import type { DurationCapability, VideoModelCapabilities } from './types';

export const VIDEO_VALIDATION_ERROR_CODES = [
  'unsupported_duration',
  'unsupported_aspect_ratio',
  'unsupported_resolution',
  'unsupported_mode',
  'missing_input_image',
  'unexpected_input_image',
  'unsupported_audio_option',
] as const;
export type VideoValidationErrorCode = (typeof VIDEO_VALIDATION_ERROR_CODES)[number];

export type VideoValidationResult =
  | { ok: true; request: ValidatedVideoRequest }
  | { ok: false; code: VideoValidationErrorCode; message: string };

const fail = (code: VideoValidationErrorCode, message: string): VideoValidationResult => ({ ok: false, code, message });

const isDurationAllowed = (seconds: number, duration: DurationCapability): boolean => {
  if (duration.kind === 'discrete') return duration.values.includes(seconds);
  if (seconds < duration.min || seconds > duration.max) return false;
  // Float-safe step check: 3.5 on a step-1 range is rejected, 4 is accepted.
  const stepsFromMin = (seconds - duration.min) / duration.step;
  return Math.abs(stepsFromMin - Math.round(stepsFromMin)) < 1e-9;
};

const describeDuration = (duration: DurationCapability): string =>
  duration.kind === 'discrete'
    ? `allowed: ${duration.values.join(', ')}s`
    : `allowed: ${duration.min}-${duration.max}s in ${duration.step}s steps`;

// Never rounds or clamps: a request the model cannot honour fails with a code the caller can surface.
export const validateAgainstCapabilities = (
  request: VideoGenerationRequest,
  caps: VideoModelCapabilities
): VideoValidationResult => {
  if (!caps.modes.includes(request.mode)) {
    return fail('unsupported_mode', `${caps.displayName} does not support ${request.mode}`);
  }
  if (request.mode === 'image_to_video' && !request.inputImageFileId) {
    return fail('missing_input_image', 'image_to_video requires inputImageFileId');
  }
  if (request.mode === 'text_to_video' && request.inputImageFileId) {
    return fail('unexpected_input_image', 'inputImageFileId is only valid for image_to_video');
  }
  if (!isDurationAllowed(request.durationSeconds, caps.duration)) {
    return fail(
      'unsupported_duration',
      `duration ${request.durationSeconds}s is not supported by ${caps.displayName} (${describeDuration(caps.duration)})`
    );
  }
  if (!caps.aspectRatios.includes(request.aspectRatio)) {
    return fail(
      'unsupported_aspect_ratio',
      `aspect ratio ${request.aspectRatio} is not supported by ${caps.displayName} (allowed: ${caps.aspectRatios.join(', ')})`
    );
  }
  if (!caps.resolutions.includes(request.resolution)) {
    return fail(
      'unsupported_resolution',
      `resolution ${request.resolution} is not supported by ${caps.displayName} (allowed: ${caps.resolutions.join(', ')})`
    );
  }
  if (request.audio !== undefined && caps.audio !== 'optional') {
    return fail('unsupported_audio_option', `${caps.displayName} audio is '${caps.audio}' and cannot be toggled`);
  }
  return { ok: true, request: request as ValidatedVideoRequest };
};
```

- [ ] **Step 5: Run validation tests to verify they pass**

Run: `pnpm --filter @bike4mind/common exec vitest run src/video/validate.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Write failing cost and catalog-integrity tests**

`b4m-core/common/src/video/estimateCost.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { usdToCredits } from '../pricing';
import type { VideoModelCapabilities } from './types';
import type { VideoGenerationRequest } from './request';
import { estimateVideoCostCredits, estimateVideoCostUsd } from './estimateCost';

const perSecond: VideoModelCapabilities = {
  provider: 'test',
  displayName: 'Per second',
  modes: ['text_to_video'],
  duration: { kind: 'range', min: 3, max: 10, step: 1 },
  aspectRatios: ['16:9'],
  resolutions: ['720p', '1080p'],
  defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
  audio: 'none',
  pricing: { unit: 'per_second', usdByResolution: { '720p': 0.1, '1080p': 0.25 } },
  defaultEnabled: true,
};
const perClip: VideoModelCapabilities = {
  ...perSecond,
  duration: { kind: 'discrete', values: [6, 10] },
  pricing: {
    unit: 'per_clip',
    clips: [
      { durationSeconds: 6, resolution: '720p', usd: 0.28 },
      { durationSeconds: 10, resolution: '720p', usd: 0.56 },
    ],
  },
};
const request = (overrides: Partial<VideoGenerationRequest>): VideoGenerationRequest => ({
  model: 'test-video',
  mode: 'text_to_video',
  prompt: 'p',
  durationSeconds: 4,
  aspectRatio: '16:9',
  resolution: '720p',
  ...overrides,
});

describe('estimateVideoCostUsd', () => {
  it('multiplies the per-second rate for the resolution by the duration', () => {
    expect(estimateVideoCostUsd(perSecond, request({ durationSeconds: 8, resolution: '1080p' }))).toBeCloseTo(2);
  });

  it('looks up the exact per-clip price', () => {
    expect(estimateVideoCostUsd(perClip, request({ durationSeconds: 10 }))).toBeCloseTo(0.56);
  });

  it('throws on a per-clip combination the model does not price (a declaration bug, not user input)', () => {
    expect(() => estimateVideoCostUsd(perClip, request({ durationSeconds: 6, resolution: '1080p' }))).toThrow(
      /no per_clip price/
    );
  });
});

describe('estimateVideoCostCredits', () => {
  it('converts through usdToCredits so the shown estimate equals the held amount', () => {
    expect(estimateVideoCostCredits(perSecond, request({ durationSeconds: 5 }))).toBe(usdToCredits(0.5));
  });
});
```

`b4m-core/common/src/video/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS } from './catalog';
import { validateAgainstCapabilities } from './validate';
import { estimateVideoCostUsd } from './estimateCost';

// Guards every future declaration: a model must accept its own defaults and price every
// resolution/duration it declares, or the studio would offer an option the server rejects.
describe.each(VIDEO_MODEL_IDS)('catalog entry %s', id => {
  const caps = VIDEO_MODEL_CATALOG[id];

  it('accepts its own defaults', () => {
    const result = validateAgainstCapabilities(
      { model: id, mode: 'text_to_video', prompt: 'p', ...caps.defaults },
      caps.modes.includes('text_to_video') ? caps : { ...caps, modes: [...caps.modes, 'text_to_video'] }
    );
    expect(result.ok).toBe(true);
  });

  it('prices every declared resolution at its default duration', () => {
    for (const resolution of caps.resolutions) {
      const usd = estimateVideoCostUsd(caps, {
        model: id,
        mode: 'text_to_video',
        prompt: 'p',
        ...caps.defaults,
        resolution,
      });
      expect(usd).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm --filter @bike4mind/common exec vitest run src/video/estimateCost.test.ts src/video/catalog.test.ts`
Expected: FAIL - `Cannot find module './estimateCost'`.

- [ ] **Step 8: Implement `estimateCost.ts` and the barrel**

```ts
import { usdToCredits } from '../pricing';
import type { VideoGenerationRequest } from './request';
import type { VideoModelCapabilities } from './types';

export const estimateVideoCostUsd = (caps: VideoModelCapabilities, request: VideoGenerationRequest): number => {
  const { pricing } = caps;
  if (pricing.unit === 'per_second') {
    const rate = pricing.usdByResolution[request.resolution];
    if (rate === undefined) {
      throw new Error(`${caps.displayName}: no per_second price for ${request.resolution}`);
    }
    return rate * request.durationSeconds;
  }
  const clip = pricing.clips.find(
    c => c.durationSeconds === request.durationSeconds && c.resolution === request.resolution
  );
  if (!clip) {
    throw new Error(
      `${caps.displayName}: no per_clip price for ${request.durationSeconds}s at ${request.resolution}`
    );
  }
  return clip.usd;
};

// Shared by the studio (display) and the server (credit hold) so the two can never drift.
export const estimateVideoCostCredits = (caps: VideoModelCapabilities, request: VideoGenerationRequest): number =>
  usdToCredits(estimateVideoCostUsd(caps, request));
```

`b4m-core/common/src/video/index.ts`:

```ts
export * from './types';
export * from './catalog';
export * from './request';
export * from './validate';
export * from './estimateCost';
export * from './limits';
```

Add `export * from './video';` to `b4m-core/common/src/index.ts` next to the other domain barrels.

- [ ] **Step 9: Run all video tests and typecheck**

Run: `pnpm --filter @bike4mind/common exec vitest run src/video && pnpm --filter @bike4mind/common typecheck`
Expected: PASS; typecheck clean. If the barrel export collides with an existing export name in `src/index.ts` (e.g. an older `AspectRatio` type), rename the new symbol with a `Video` prefix everywhere in this task rather than changing the old one.

- [ ] **Step 10: Commit**

```bash
git add b4m-core/common/src/video b4m-core/common/src/index.ts
git commit -m "feat(video): add provider-neutral video capability domain"
```

---

### Task 2: Store generated video as media-only Files

Generated video must be storable as a FabFile but excluded from every LLM-attachment, chunking and vectorization path, exactly like generated audio today.

**Files:**
- Modify: `b4m-core/common/src/types/common.ts:146-165` (add `isVideoMimeType`, `isMediaOnlyMimeType`; widen `isStorableFabFileMimeType`)
- Modify: `b4m-core/common/src/types/entities/FabFileTypes.ts:30` (add `VIDEO`)
- Modify (switch `isAudioMimeType` -> `isMediaOnlyMimeType` where the intent is "not ingestable"):
  - `b4m-core/fab-pipeline/src/chunk.ts:346`
  - `b4m-core/utils/src/llm/utils.ts:1532`
  - `apps/client/server/s3/objectCreated.ts:251`
  - `apps/client/server/s3/chunkScan.ts` (the Mongo query documented at `:72` as "in sync with isAudioMimeType")
  - `apps/client/app/components/Files/Browser/Content.tsx:262-263`
- Do NOT change `apps/client/app/components/Files/Browser/Item.tsx` audio-player branches (`:68`, `:457`, `:795`); a video player there is plan 4.
- Test: `b4m-core/common/src/types/common.test.ts` (create if absent; else add a `describe`)

**Interfaces:**
- Produces: `isVideoMimeType(mimeType: string | null | undefined): boolean`, `isMediaOnlyMimeType(mimeType: string | null | undefined): boolean`, `KnowledgeType.VIDEO`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { isMediaOnlyMimeType, isStorableFabFileMimeType, isVideoMimeType } from './common';

describe('media-only MIME guards', () => {
  it.each(['video/mp4', 'VIDEO/MP4', 'video/webm; codecs=vp9'])('isVideoMimeType(%s) is true', m => {
    expect(isVideoMimeType(m)).toBe(true);
  });

  it.each([null, undefined, '', 'audio/mpeg', 'application/pdf'])('isVideoMimeType(%s) is false', m => {
    expect(isVideoMimeType(m)).toBe(false);
  });

  it('treats audio and video as media-only and nothing else', () => {
    expect(isMediaOnlyMimeType('audio/mpeg')).toBe(true);
    expect(isMediaOnlyMimeType('video/mp4')).toBe(true);
    expect(isMediaOnlyMimeType('application/pdf')).toBe(false);
  });

  it('allows video to be stored as a FabFile', () => {
    expect(isStorableFabFileMimeType('video/mp4')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bike4mind/common exec vitest run src/types/common.test.ts`
Expected: FAIL - `isVideoMimeType is not a function` (or not exported).

- [ ] **Step 3: Implement in `types/common.ts`** (insert after `isAudioMimeType`, replace `isStorableFabFileMimeType`)

```ts
/** Is this a video MIME type? Matches any `video/*`, mirroring isAudioMimeType's fail-safe breadth. */
export function isVideoMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return mimeType.split(';')[0].trim().toLowerCase().startsWith('video/');
}

/**
 * Storable and browsable, but never chunked, vectorized or attached to an LLM call.
 * Every "skip ingestion" guard uses this, so a new media kind is excluded everywhere at once.
 */
export function isMediaOnlyMimeType(mimeType: string | null | undefined): boolean {
  return isAudioMimeType(mimeType) || isVideoMimeType(mimeType);
}

export function isStorableFabFileMimeType(mimeType: string | null | undefined): boolean {
  return isSupportedFabFileMimeType(mimeType) || isMediaOnlyMimeType(mimeType);
}
```

In `FabFileTypes.ts`, after `AUDIO = 'AUDIO',`:

```ts
  /** Generated video. Media-only like AUDIO: storable and browsable, never ingested. */
  VIDEO = 'VIDEO',
```

Check whether the FabFile Mongoose schema restricts `type` with `enum: Object.values(KnowledgeType)`; if it hard-codes a list instead, add `'VIDEO'` there too: `grep -rn "KnowledgeType" packages/database/src/models/content/FabFileModel.ts`.

- [ ] **Step 4: Switch the ingestion guards**

In each listed call site, replace `isAudioMimeType` with `isMediaOnlyMimeType` and update the import. For `chunkScan.ts`, read the query near `:72`: it filters audio with a Mongo expression (a regex such as `/^audio\//i` on `mimeType`). Widen it to `/^(audio|video)\//i` and update its sync comment to name `isMediaOnlyMimeType`. For `chunk.ts:346` and `llm/utils.ts:1532`, keep any audio-specific log text accurate (e.g. "media-only file" instead of "audio file").

- [ ] **Step 5: Run the affected suites**

Run: `pnpm turbo:core:build && pnpm --filter @bike4mind/common exec vitest run src/types && pnpm --filter @bike4mind/fab-pipeline test && pnpm --filter @bike4mind/utils exec vitest run src/llm && pnpm --filter @bike4mind/client exec vitest run server/s3 app/components/Files`
Expected: PASS. Any existing test asserting audio-specific behaviour still passes because audio remains media-only.

- [ ] **Step 6: Commit**

```bash
git add b4m-core/common/src/types b4m-core/fab-pipeline/src/chunk.ts b4m-core/utils/src/llm/utils.ts apps/client/server/s3 apps/client/app/components/Files/Browser/Content.tsx
git commit -m "feat(files): treat generated video as media-only like audio"
```

---

### Task 3: Serializable credit holds

Extract the money movement from `apps/client/server/billing/reserveRequestCredits.ts` into `b4m-core/services/src/creditService/creditHold.ts` as functions over a plain-data `CreditHold`, so a job created in one Lambda can be settled or released by another. Rewrite `reserveRequestCredits` on top of them with identical behaviour.

**Files:**
- Create: `b4m-core/services/src/creditService/creditHold.ts`, `creditHold.test.ts`
- Modify: `b4m-core/services/src/creditService/index.ts` (export the new module)
- Modify: `apps/client/server/billing/reserveRequestCredits.ts` (delegate; keep its exports `reserveRequestCredits`, `CreditReservation`, and re-export `CreditLedgerEntry` from services)
- Test (must stay green unchanged): `apps/client/server/billing/reserveRequestCredits.test.ts` (7 cases)

**Interfaces:**
- Consumes: `deductCreditsWithOrgSupport`, `isMemberCreditCapExceeded` (same package, `creditService/`), `insufficientCreditsError`, `CreditHolderType`, `ICreditHolderMethods`, `IUserDocument`, `IOrganizationDocument`, `ICreditHolder` from `@bike4mind/common`, `Logger` from `@bike4mind/observability`.
- Produces:

```ts
export type CreditHold = {
  ownerId: string;
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  userId: string;
  organizationId: string | null;
  reservedCredits: number;
};
export type CreditLedgerEntry = DistributiveOmit<DeductCreditsParams, 'user' | 'organization' | 'credits'>;
export type CreditHoldAdapters = {
  users: ICreditHolderMethods & { findById(id: string): Promise<IUserDocument | null> };
  organizations: ICreditHolderMethods & { findById(id: string): Promise<IOrganizationDocument | null> };
  creditTransactions: DeductCreditsAdapters['db']['creditTransactions'];
};
export function holdCredits(params: {
  userId: string;
  organizationId: string | null;
  requiredCredits: number;
  featureLabel: string;
  // Runs after the user/org are loaded and before any balance moves; throw to refuse.
  assertBillable?: (user: IUserDocument, organization: IOrganizationDocument | null) => void;
}, adapters: CreditHoldAdapters): Promise<CreditHold>;
export function settleCreditHold(
  hold: CreditHold, chargedCredits: number, entry: CreditLedgerEntry,
  context: { featureLabel: string; logger: Logger }, adapters: CreditHoldAdapters
): Promise<number>;
export function releaseCreditHold(hold: CreditHold, adapters: Pick<CreditHoldAdapters, 'users' | 'organizations'>): Promise<void>;
```

- [ ] **Step 1: Read the source and its test**

Read `apps/client/server/billing/reserveRequestCredits.ts` (227 lines) and `reserveRequestCredits.test.ts`. The parts are: owner resolution (L72-81), no-op reservation (L83-85), load docs (L87-93), API-key membership fail-closed check (L95-114), member cap (L119-123), atomic hold with rollback (L128-137), `refund` (L143-145), `settle` clamp (L146-158), and module-private `settleReservation` (L162-227). Keep every log message and error string byte-identical.

- [ ] **Step 2: Write the failing tests**

`b4m-core/services/src/creditService/creditHold.test.ts` uses in-memory adapters (no Mongo needed: the functions only call the adapter methods).

```ts
import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import type { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { holdCredits, releaseCreditHold, settleCreditHold, type CreditHoldAdapters } from './creditHold';

vi.mock('./deductCreditsWithOrgSupport', () => ({ deductCreditsWithOrgSupport: vi.fn(async () => undefined) }));
import { deductCreditsWithOrgSupport } from './deductCreditsWithOrgSupport';

const makeAdapters = (balances: { user: number; org?: number }) => {
  const state = { user: balances.user, org: balances.org ?? 0 };
  const user = { id: 'u1', currentCredits: state.user } as unknown as IUserDocument;
  const org = { id: 'o1', currentCredits: state.org } as unknown as IOrganizationDocument;
  const adapters: CreditHoldAdapters = {
    users: {
      findById: vi.fn(async () => ({ ...user, currentCredits: state.user }) as IUserDocument),
      incrementCredits: vi.fn(async (_id: string, delta: number) => {
        state.user += delta;
        return { id: 'u1', currentCredits: state.user } as never;
      }),
    },
    organizations: {
      findById: vi.fn(async () => ({ ...org, currentCredits: state.org }) as IOrganizationDocument),
      incrementCredits: vi.fn(async (_id: string, delta: number) => {
        state.org += delta;
        return { id: 'o1', currentCredits: state.org } as never;
      }),
    },
    creditTransactions: {} as CreditHoldAdapters['creditTransactions'],
  };
  return { adapters, state };
};
const logger = new Logger({ metadata: { test: 'creditHold' } });

describe('holdCredits', () => {
  it('moves the credits out of the user balance and returns plain data', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits({ userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video' }, adapters);
    expect(hold).toEqual({ ownerId: 'u1', ownerType: CreditHolderType.User, userId: 'u1', organizationId: null, reservedCredits: 30 });
    expect(state.user).toBe(70);
    expect(JSON.parse(JSON.stringify(hold))).toEqual(hold);
  });

  it('bills the organization pool when an organization is given', async () => {
    const { adapters, state } = makeAdapters({ user: 0, org: 50 });
    const hold = await holdCredits({ userId: 'u1', organizationId: 'o1', requiredCredits: 20, featureLabel: 'video' }, adapters);
    expect(hold.ownerType).toBe(CreditHolderType.Organization);
    expect(state.org).toBe(30);
  });

  it('rolls back and throws insufficient credits when the hold overdraws', async () => {
    const { adapters, state } = makeAdapters({ user: 10 });
    await expect(
      holdCredits({ userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video' }, adapters)
    ).rejects.toThrow(/do not have enough credits for video/);
    expect(state.user).toBe(10);
  });

  it('runs assertBillable before moving any balance', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    await expect(
      holdCredits(
        { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', assertBillable: () => { throw new Error('nope'); } },
        adapters
      )
    ).rejects.toThrow('nope');
    expect(state.user).toBe(100);
  });
});

describe('settleCreditHold', () => {
  const entry = { type: 'video_generation_usage', sessionId: 's1', model: 'test-video' } as never;

  it('refunds the over-reservation and writes the ledger row for what was kept', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits({ userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video' }, adapters);
    const charged = await settleCreditHold(hold, 20, entry, { featureLabel: 'video', logger }, adapters);
    expect(charged).toBe(20);
    expect(state.user).toBe(80);
    expect(deductCreditsWithOrgSupport).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 20 }),
      expect.anything(),
      expect.objectContaining({ skipBalanceUpdate: true })
    );
  });

  it('never keeps more than it reserved', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits({ userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video' }, adapters);
    expect(await settleCreditHold(hold, 999, entry, { featureLabel: 'video', logger }, adapters)).toBe(30);
    expect(state.user).toBe(70);
  });
});

describe('releaseCreditHold', () => {
  it('returns the whole reservation', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits({ userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video' }, adapters);
    await releaseCreditHold(hold, adapters);
    expect(state.user).toBe(100);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @bike4mind/services exec vitest run src/creditService/creditHold.test.ts`
Expected: FAIL - `Cannot find module './creditHold'`.

- [ ] **Step 4: Implement `creditHold.ts`**

Move the hold, member-cap, settle and refund logic verbatim from `reserveRequestCredits.ts`, adapted to the signatures above:

```ts
import {
  CreditHolderType,
  insufficientCreditsError,
  type ICreditHolder,
  type ICreditHolderMethods,
  type IOrganizationDocument,
  type IUserDocument,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { deductCreditsWithOrgSupport, type DeductCreditsAdapters } from './deductCreditsWithOrgSupport';
import { isMemberCreditCapExceeded } from './memberCreditCap';

type DeductCreditsParams = Parameters<typeof deductCreditsWithOrgSupport>[0];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CreditLedgerEntry = DistributiveOmit<DeductCreditsParams, 'user' | 'organization' | 'credits'>;

// Plain data so it can be stored on a job document and settled by a different process.
export type CreditHold = {
  ownerId: string;
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  userId: string;
  organizationId: string | null;
  reservedCredits: number;
};

export type CreditHoldAdapters = {
  users: ICreditHolderMethods & { findById(id: string): Promise<IUserDocument | null> };
  organizations: ICreditHolderMethods & { findById(id: string): Promise<IOrganizationDocument | null> };
  creditTransactions: DeductCreditsAdapters['db']['creditTransactions'];
};

const holderMethodsFor = (hold: Pick<CreditHold, 'ownerType'>, adapters: Pick<CreditHoldAdapters, 'users' | 'organizations'>) =>
  hold.ownerType === CreditHolderType.Organization ? adapters.organizations : adapters.users;

export async function holdCredits(
  params: {
    userId: string;
    organizationId: string | null;
    requiredCredits: number;
    featureLabel: string;
    assertBillable?: (user: IUserDocument, organization: IOrganizationDocument | null) => void;
  },
  adapters: CreditHoldAdapters
): Promise<CreditHold> {
  const { userId, organizationId, requiredCredits, featureLabel } = params;
  const user = await adapters.users.findById(userId);
  if (!user) throw new Error('User not found');
  const organization = organizationId ? await adapters.organizations.findById(organizationId) : null;
  if (organizationId && !organization) throw new Error('Billing organization not found');

  params.assertBillable?.(user, organization);

  // The settlement write deliberately does not re-check the cap, so this is the only enforcement point.
  if (organization && isMemberCreditCapExceeded(organization, userId, requiredCredits)) {
    throw insufficientCreditsError(
      `Your organization member credit limit has been reached for ${featureLabel}. Contact your organization administrator.`
    );
  }

  const hold: CreditHold = {
    ownerId: organization ? organization.id : userId,
    ownerType: organization ? CreditHolderType.Organization : CreditHolderType.User,
    userId,
    organizationId: organization ? organization.id : null,
    reservedCredits: requiredCredits,
  };
  const holderMethods = holderMethodsFor(hold, adapters);

  // PASTE VERBATIM from reserveRequestCredits.ts L128-137 (the atomic incrementCredits(-n),
  // rollback-if-negative and both insufficientCreditsError messages), with `billingOrg` -> `organization`.
  const reservedHolder = await holderMethods.incrementCredits(hold.ownerId, -requiredCredits);
  if (!reservedHolder || reservedHolder.currentCredits < 0) {
    if (reservedHolder) await holderMethods.incrementCredits(hold.ownerId, requiredCredits);
    const availableCredits = (reservedHolder?.currentCredits ?? 0) + requiredCredits;
    throw insufficientCreditsError(
      organization
        ? `Your organization does not have enough credits for ${featureLabel}. It currently has ${availableCredits} credits and this requires approximately ${requiredCredits}.`
        : `You do not have enough credits for ${featureLabel}. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
    );
  }
  return hold;
}

export async function releaseCreditHold(
  hold: CreditHold,
  adapters: Pick<CreditHoldAdapters, 'users' | 'organizations'>
): Promise<void> {
  if (hold.reservedCredits <= 0) return;
  await holderMethodsFor(hold, adapters).incrementCredits(hold.ownerId, hold.reservedCredits);
}

export async function settleCreditHold(
  hold: CreditHold,
  chargedCredits: number,
  entry: CreditLedgerEntry,
  context: { featureLabel: string; logger: Logger },
  adapters: CreditHoldAdapters
): Promise<number> {
  const charged = Math.min(Math.max(chargedCredits, 0), hold.reservedCredits);
  const holderMethods = holderMethodsFor(hold, adapters);
  const overReserved = hold.reservedCredits - charged;

  let settledHolder: ICreditHolder | null = null;
  if (overReserved > 0) {
    try {
      settledHolder = await holderMethods.incrementCredits(hold.ownerId, overReserved);
    } catch (error) {
      // PASTE the exact logger.error message from settleReservation.
      context.logger.error(`${context.featureLabel} over-reserved credit refund failed - caller over-charged`, {
        ownerId: hold.ownerId,
        overReserved,
        error,
      });
    }
  }
  if (charged === 0) return 0;

  const user = await adapters.users.findById(hold.userId);
  const organization = hold.organizationId ? await adapters.organizations.findById(hold.organizationId) : null;
  // The ledger row records the balance after the refund; fall back to the holder doc when no refund ran.
  const currentCreditHolder = settledHolder ?? (organization ?? user);
  try {
    await deductCreditsWithOrgSupport(
      { ...entry, user, organization, credits: charged } as DeductCreditsParams,
      { db: { creditTransactions: adapters.creditTransactions, users: adapters.users, organizations: adapters.organizations } },
      { skipBalanceUpdate: true, currentCreditHolder: currentCreditHolder ?? undefined }
    );
  } catch (error) {
    // PASTE the exact logger.error message from settleReservation's ledger catch.
    context.logger.error(`${context.featureLabel} usage transaction write failed - credits charged, ledger row missing`, {
      userId: hold.userId,
      organizationId: hold.organizationId,
      error,
    });
  }
  return charged;
}
```

Notes for the implementer:
- Check the exact types `deductCreditsWithOrgSupport` expects for `db.users` / `db.organizations` (`b4m-core/services/src/creditService/deductCreditsWithOrgSupport.ts:~20-60`) and the export name of its adapters type; if it is not exported, export it (`export type DeductCreditsAdapters`). Narrow `CreditHoldAdapters` to exactly what both functions use.
- `isMemberCreditCapExceeded` lives in `memberCreditCap.ts:88` in the same folder.
- Compare against `settleReservation` line by line: the order "refund, early-return at zero, ledger write" must match, and neither catch rethrows.

Export from `b4m-core/services/src/creditService/index.ts`: `export * from './creditHold';`.

- [ ] **Step 5: Run the new tests**

Run: `pnpm --filter @bike4mind/services exec vitest run src/creditService/creditHold.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Rewrite `reserveRequestCredits` on top of the holds**

Keep owner resolution (L72-81), the no-op reservation (L83-85) and the API-key membership check (as `assertBillable`, still throwing the same `BadRequestError` with the same message and the explanatory comment from L95-104). Replace the hold / refund / settle bodies:

```ts
const hold = await creditService.holdCredits(
  {
    userId,
    organizationId: billingOrganizationId ?? null,
    requiredCredits,
    featureLabel,
    assertBillable: (billingUser, billingOrg) => {
      // (keep the original L95-104 comment here)
      if (billingOrg && req.apiKeyInfo && !billingUser.isAdmin && !organizationService.isCurrentOrgMember(billingOrg, userId)) {
        throw new BadRequestError('This API key bills an organization you are no longer a member of. Re-mint the key to continue.');
      }
    },
  },
  holdAdapters
);
return {
  ownerId: hold.ownerId,
  ownerType: hold.ownerType,
  reservedCredits: hold.reservedCredits,
  refund: () => creditService.releaseCreditHold(hold, holdAdapters),
  settle: (chargedCredits, entry) =>
    creditService.settleCreditHold(hold, chargedCredits, entry, { featureLabel, logger: req.logger }, holdAdapters),
};
```

with `const holdAdapters = { users: userRepository, organizations: organizationRepository, creditTransactions: creditTransactionRepository };`. Keep the existing `User not found` / `Billing organization not found` `BadRequestError`s by loading the docs in the wrapper only if `holdCredits` would otherwise throw a plain `Error` for them: simplest is to catch `holdCredits`'s `'User not found'` / `'Billing organization not found'` errors and rethrow as `BadRequestError` with the same text. Re-export `export type { CreditLedgerEntry } from '@bike4mind/services/creditService';` (check the subpath export name in `b4m-core/services/package.json:53`).

- [ ] **Step 7: Run the untouched existing suite and callers**

Run: `pnpm turbo:core:build && pnpm --filter @bike4mind/client exec vitest run server/billing pages/api/ai/__tests__/music.test.ts pages/api/ai/__tests__/sound-effects.test.ts pages/api/v1/__tests__/embeddings.test.ts`
Expected: PASS, with `reserveRequestCredits.test.ts` unmodified. If a test mocks `@bike4mind/database` repos and now needs `findById` on the user/org repo mocks, add it to the mock (do not change assertions).

- [ ] **Step 8: Commit**

```bash
git add b4m-core/services/src/creditService apps/client/server/billing
git commit -m "refactor(credits): extract serializable credit holds from request reservations"
```

---

### Task 4: Provider interface, registry and deterministic test provider (utils)

**Files:**
- Create: `b4m-core/utils/src/videoProviders/types.ts`, `registry.ts`, `index.ts`
- Create: `b4m-core/utils/src/videoProviders/test/TestVideoProvider.ts`, `test/fixtureVideo.ts`, `test/TestVideoProvider.test.ts`
- Create: `b4m-core/utils/src/videoProviders/conformance.ts` (shared suite used by every adapter in plans 2-3)
- Modify: `b4m-core/utils/package.json` (add a `./videoProviders` subpath export mirroring an existing one, e.g. the `imageGeneration` entry) and `b4m-core/utils/src/index.ts` only if utils re-exports domains from its root (follow what `imageGeneration` does)

**Interfaces:**
- Consumes: `ValidatedVideoRequest`, `VideoProviderId`, `VideoModelId`, `MAX_VIDEO_OUTPUT_BYTES` from `@bike4mind/common`; `Logger` from `@bike4mind/observability`.
- Produces (verbatim, used by Task 8 and plans 2-3):

```ts
export type ProviderJobHandle = { provider: VideoProviderId; data: Record<string, unknown> };
export type ProviderOutput =
  | { kind: 'inline'; base64: string; contentType: string }
  | { kind: 'url'; url: string; requiresAuth: boolean; contentType?: string };
export type ProviderPollResult =
  | { status: 'running'; progress?: number }
  | { status: 'succeeded'; output: ProviderOutput; reportedDurationSeconds?: number }
  | { status: 'blocked'; reason?: string; raw: unknown }
  | { status: 'failed'; retryable: boolean; message: string; raw: unknown };
export type ResolvedInputs = { inputImage?: { bytes: Buffer; mimeType: string } };
export type VideoProviderContext = { apiKey: string; logger: Logger; now: () => Date };
export interface VideoProvider {
  readonly id: VideoProviderId;
  submit(request: ValidatedVideoRequest, inputs: ResolvedInputs, ctx: VideoProviderContext): Promise<ProviderJobHandle>;
  poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult>;
  fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer>;
  cancel?(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<void>;
}
export class ProviderSubmitError extends Error {
  constructor(message: string, readonly definitive: boolean, readonly raw?: unknown);
}
export class VideoOutputTooLargeError extends Error {}
export type VideoProviderRegistry = { get(id: VideoProviderId): VideoProvider | undefined; ids(): VideoProviderId[] };
export function createVideoProviderRegistry(providers: readonly VideoProvider[]): VideoProviderRegistry;
export function readBoundedResponse(response: Response, maxBytes?: number): Promise<Buffer>;
export class TestVideoProvider implements VideoProvider { /* id: 'test' */ }
export function describeVideoProviderConformance(name: string, setup: ConformanceSetup): void;
```

- [ ] **Step 1: Write `types.ts` and `registry.ts`**

```ts
// types.ts
import type { ValidatedVideoRequest, VideoProviderId } from '@bike4mind/common';
import { MAX_VIDEO_OUTPUT_BYTES } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

// Opaque to everything but its adapter; persisted on the job as JSON.
export type ProviderJobHandle = { provider: VideoProviderId; data: Record<string, unknown> };

export type ProviderOutput =
  | { kind: 'inline'; base64: string; contentType: string }
  | { kind: 'url'; url: string; requiresAuth: boolean; contentType?: string };

// Expected provider outcomes are values, never exceptions; adapters throw only for transport or programmer errors.
export type ProviderPollResult =
  | { status: 'running'; progress?: number }
  | { status: 'succeeded'; output: ProviderOutput; reportedDurationSeconds?: number }
  | { status: 'blocked'; reason?: string; raw: unknown }
  | { status: 'failed'; retryable: boolean; message: string; raw: unknown };

export type ResolvedInputs = { inputImage?: { bytes: Buffer; mimeType: string } };

export type VideoProviderContext = { apiKey: string; logger: Logger; now: () => Date };

// Every method is one bounded call: no method sleeps, loops or polls. The job engine owns waiting.
export interface VideoProvider {
  readonly id: VideoProviderId;
  submit(request: ValidatedVideoRequest, inputs: ResolvedInputs, ctx: VideoProviderContext): Promise<ProviderJobHandle>;
  poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult>;
  fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer>;
  cancel?(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<void>;
}

/**
 * `definitive: true` means the provider answered and created nothing (a 4xx/429 response), so the
 * engine may retry the submit. Anything else (timeout, reset) leaves the outcome unknown and the
 * engine must not resubmit - see the orphaned-submit section of the design spec.
 */
export class ProviderSubmitError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
    readonly raw?: unknown
  ) {
    super(message);
    this.name = 'ProviderSubmitError';
  }
}

export class VideoOutputTooLargeError extends Error {
  constructor(bytes: number) {
    super(`video output exceeds ${MAX_VIDEO_OUTPUT_BYTES} bytes (got at least ${bytes})`);
    this.name = 'VideoOutputTooLargeError';
  }
}

// Shared by URL-delivering adapters so the size cap is enforced while streaming, not after buffering everything.
export async function readBoundedResponse(response: Response, maxBytes = MAX_VIDEO_OUTPUT_BYTES): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new VideoOutputTooLargeError(declared);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new VideoOutputTooLargeError(total);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
```

```ts
// registry.ts
import type { VideoProviderId } from '@bike4mind/common';
import type { VideoProvider } from './types';

export type VideoProviderRegistry = {
  get(id: VideoProviderId): VideoProvider | undefined;
  ids(): VideoProviderId[];
};

export const createVideoProviderRegistry = (providers: readonly VideoProvider[]): VideoProviderRegistry => {
  const byId = new Map<VideoProviderId, VideoProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`duplicate video provider: ${provider.id}`);
    byId.set(provider.id, provider);
  }
  return { get: id => byId.get(id), ids: () => [...byId.keys()] };
};
```

- [ ] **Step 2: Generate the MP4 fixture**

Run (needs `ffmpeg`; on macOS `brew install ffmpeg` if absent):

```bash
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x180:rate=24 -pix_fmt yuv420p -movflags +faststart /tmp/b4m-test-video.mp4
ls -l /tmp/b4m-test-video.mp4   # expect well under 100KB
{
  echo '// Generated: 2s 320x180 ffmpeg testsrc clip, base64. Regenerate with the command in the video foundation plan, Task 4.'
  printf "export const FIXTURE_VIDEO_BASE64 =\n  '%s';\n" "$(base64 < /tmp/b4m-test-video.mp4 | tr -d '\n')"
} > b4m-core/utils/src/videoProviders/test/fixtureVideo.ts
```

Expected: the file is ASCII and under ~130KB. If it is larger, lower `size` to `160x90`.

- [ ] **Step 3: Write the shared conformance suite**

`b4m-core/utils/src/videoProviders/conformance.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { ProviderPollResult, VideoProvider, VideoProviderContext } from './types';

/**
 * Every adapter must pass this. `scenario(name)` returns the request (and any fixture setup the adapter
 * needs, e.g. msw handlers for recorded responses) that drives the provider to that outcome.
 */
export type ConformanceSetup = {
  provider: () => VideoProvider;
  context?: Partial<VideoProviderContext>;
  scenario: (name: 'succeeds' | 'blocked' | 'fails') => Promise<ValidatedVideoRequest> | ValidatedVideoRequest;
  // Advance whatever clock or fixture state makes the provider report completion.
  settle: () => Promise<void> | void;
};

const pollUntilTerminal = async (
  provider: VideoProvider,
  handle: Awaited<ReturnType<VideoProvider['submit']>>,
  ctx: VideoProviderContext,
  settle: () => Promise<void> | void
): Promise<ProviderPollResult> => {
  for (let i = 0; i < 10; i++) {
    const result = await provider.poll(handle, ctx);
    if (result.status !== 'running') return result;
    await settle();
  }
  throw new Error('provider never left running within 10 polls');
};

export function describeVideoProviderConformance(name: string, setup: ConformanceSetup): void {
  const ctx = (): VideoProviderContext => ({
    apiKey: 'test-key',
    logger: new Logger({ metadata: { conformance: name } }),
    now: () => new Date(),
    ...setup.context,
  });

  describe(`${name} conformance`, () => {
    it('submits and returns a JSON-serialisable handle tagged with its provider id', async () => {
      const provider = setup.provider();
      const handle = await provider.submit(await setup.scenario('succeeds'), {}, ctx());
      expect(handle.provider).toBe(provider.id);
      expect(JSON.parse(JSON.stringify(handle))).toEqual(handle);
    });

    it('reports succeeded with output that fetchOutput turns into non-empty bytes', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('succeeds'), {}, c);
      const result = await pollUntilTerminal(provider, handle, c, setup.settle);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      const bytes = await provider.fetchOutput(result.output, c);
      expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it('reports a policy block as blocked, not failed', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('blocked'), {}, c);
      expect((await pollUntilTerminal(provider, handle, c, setup.settle)).status).toBe('blocked');
    });

    it('reports a provider failure as a failed value with a retryable flag', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('fails'), {}, c);
      const result = await pollUntilTerminal(provider, handle, c, setup.settle);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(typeof result.retryable).toBe('boolean');
    });
  });
}
```

- [ ] **Step 4: Write the failing test-provider test**

`b4m-core/utils/src/videoProviders/test/TestVideoProvider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { describeVideoProviderConformance } from '../conformance';
import { TestVideoProvider } from './TestVideoProvider';

let clock = new Date('2026-10-06T00:00:00Z');
const request = (prompt: string) =>
  ({ model: 'test-video', mode: 'text_to_video', prompt, durationSeconds: 2, aspectRatio: '16:9', resolution: '720p' }) as ValidatedVideoRequest;

describeVideoProviderConformance('TestVideoProvider', {
  provider: () => new TestVideoProvider(),
  context: { now: () => clock },
  scenario: name => request(name === 'blocked' ? 'a cat [blocked]' : name === 'fails' ? 'a cat [fail]' : 'a cat'),
  settle: () => {
    clock = new Date(clock.getTime() + 5_000);
  },
});

describe('TestVideoProvider specifics', () => {
  it('stays running until its ready time so the engine re-poll path is exercised', async () => {
    const now = new Date('2026-10-06T00:00:00Z');
    const provider = new TestVideoProvider();
    const ctx = { apiKey: 'k', logger: console as never, now: () => now };
    const handle = await provider.submit(request('a cat'), {}, ctx);
    expect((await provider.poll(handle, ctx)).status).toBe('running');
  });

  it('rejects submit with a definitive error for a "[reject]" prompt', async () => {
    const provider = new TestVideoProvider();
    await expect(
      provider.submit(request('x [reject]'), {}, { apiKey: 'k', logger: console as never, now: () => new Date() })
    ).rejects.toMatchObject({ name: 'ProviderSubmitError', definitive: true });
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm --filter @bike4mind/utils exec vitest run src/videoProviders`
Expected: FAIL - `Cannot find module './TestVideoProvider'`.

- [ ] **Step 6: Implement `TestVideoProvider.ts`**

```ts
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { FIXTURE_VIDEO_BASE64 } from './fixtureVideo';
import {
  ProviderSubmitError,
  type ProviderJobHandle,
  type ProviderOutput,
  type ProviderPollResult,
  type ResolvedInputs,
  type VideoProvider,
  type VideoProviderContext,
} from '../types';

const READY_AFTER_MS = 4_000;

/**
 * Deterministic, free provider for non-production E2E. Prompt markers pick the outcome:
 * "[reject]" fails submit definitively, "[blocked]" is a policy block, "[fail]" a non-retryable failure.
 */
export class TestVideoProvider implements VideoProvider {
  readonly id = 'test' as const;

  async submit(request: ValidatedVideoRequest, _inputs: ResolvedInputs, ctx: VideoProviderContext): Promise<ProviderJobHandle> {
    if (request.prompt.includes('[reject]')) throw new ProviderSubmitError('test provider rejected the prompt', true);
    return {
      provider: this.id,
      data: {
        outcome: request.prompt.includes('[blocked]') ? 'blocked' : request.prompt.includes('[fail]') ? 'failed' : 'succeeded',
        readyAt: ctx.now().getTime() + READY_AFTER_MS,
        durationSeconds: request.durationSeconds,
      },
    };
  }

  async poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult> {
    const readyAt = Number(handle.data.readyAt);
    if (ctx.now().getTime() < readyAt) return { status: 'running', progress: 0.5 };
    switch (handle.data.outcome) {
      case 'blocked':
        return { status: 'blocked', reason: 'test policy block', raw: handle.data };
      case 'failed':
        return { status: 'failed', retryable: false, message: 'test provider failure', raw: handle.data };
      default:
        return {
          status: 'succeeded',
          output: { kind: 'inline', base64: FIXTURE_VIDEO_BASE64, contentType: 'video/mp4' },
          reportedDurationSeconds: Number(handle.data.durationSeconds),
        };
    }
  }

  async fetchOutput(output: ProviderOutput): Promise<Buffer> {
    if (output.kind !== 'inline') throw new Error('TestVideoProvider only produces inline output');
    return Buffer.from(output.base64, 'base64');
  }

  async cancel(): Promise<void> {}
}
```

`index.ts`:

```ts
export * from './types';
export * from './registry';
export * from './conformance';
export { TestVideoProvider } from './test/TestVideoProvider';
```

Note: `conformance.ts` imports `vitest`. If `b4m-core/utils` builds `src/**` into the published bundle and `vitest` is a devDependency, do NOT export `conformance` from `index.ts`; instead import it in tests by relative path (`../conformance`) and in plans 2-3 adapters' tests the same way. Check `b4m-core/utils/tsconfig.build.json` / build config for test-file exclusion before deciding, and drop the line from `index.ts` if needed.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @bike4mind/utils exec vitest run src/videoProviders && pnpm --filter @bike4mind/utils typecheck`
Expected: PASS (4 conformance + 2 specific); typecheck clean.

- [ ] **Step 8: Write a unit test for `readBoundedResponse`** (add to `TestVideoProvider.test.ts` or a new `types.test.ts`)

```ts
import { readBoundedResponse, VideoOutputTooLargeError } from '../types';

describe('readBoundedResponse', () => {
  it('rejects early on an oversized content-length', async () => {
    const response = new Response('x', { headers: { 'content-length': String(10) } });
    await expect(readBoundedResponse(response, 5)).rejects.toBeInstanceOf(VideoOutputTooLargeError);
  });

  it('rejects while streaming when no content-length is sent', async () => {
    await expect(readBoundedResponse(new Response('0123456789'), 5)).rejects.toBeInstanceOf(VideoOutputTooLargeError);
  });

  it('returns the bytes under the cap', async () => {
    expect((await readBoundedResponse(new Response('abc'), 5)).toString()).toBe('abc');
  });
});
```

Run: `pnpm --filter @bike4mind/utils exec vitest run src/videoProviders`
Expected: PASS.

- [ ] **Step 9: Commit and open PR 1a**

```bash
git add b4m-core/utils/src/videoProviders b4m-core/utils/package.json b4m-core/utils/src/index.ts
git commit -m "feat(video): add video provider interface, registry and test provider"
```

Run the full gate before opening PR 1a: `pnpm turbo:typecheck && pnpm turbo:test && pnpm lint:check` (dispatch to a verify agent). Open PR 1a with the `/ship` skill; body: `Part of #3890` (not `Closes`).

---

### Task 5: GenerationJob entity, model, repository and index migration

**Files:**
- Create: `b4m-core/common/src/types/entities/GenerationJobTypes.ts`; export from `b4m-core/common/src/types/entities/index.ts`
- Create: `packages/database/src/models/ai/GenerationJobModel.ts`, `GenerationJobModel.test.ts`; export from `packages/database/src/models/ai/index.ts`
- Create: `packages/scripts/migrate/migrations/20260923000000_ensure-generation-job-indexes.ts`; register in `packages/scripts/migrate/migrations/index.ts` (import + array entry, after `20260922000001`)

**Interfaces:**
- Consumes: `IMongoDocument`, `IBaseRepository`, `CreditHolderType` (common); `VideoGenerationRequest`, `VideoProviderId` (common, Task 1). `ProviderJobHandle`/`ProviderOutput` are utils types; common cannot import utils, so the entity stores them structurally (`{ provider: string; data: Record<string, unknown> }`, etc.).
- Produces (verbatim):

```ts
export const GENERATION_JOB_KINDS = ['video'] as const;
export type GenerationJobKind = (typeof GENERATION_JOB_KINDS)[number];
export const GENERATION_JOB_STATES = ['pending', 'running', 'storing', 'succeeded', 'failed', 'blocked', 'cancelled'] as const;
export type GenerationJobState = (typeof GENERATION_JOB_STATES)[number];
export const TERMINAL_GENERATION_JOB_STATES: readonly GenerationJobState[] = ['succeeded', 'failed', 'blocked', 'cancelled'];
export const GENERATION_JOB_SOURCES = ['api', 'studio', 'agent'] as const;
export type GenerationJobSource = (typeof GENERATION_JOB_SOURCES)[number];
export const GENERATION_JOB_ERROR_CODES = ['content_blocked','provider_timeout','provider_error','orphaned_submit','region_unavailable','output_too_large','input_image_not_found','enqueue_failed','cancelled'] as const;
export type GenerationJobErrorCode = (typeof GENERATION_JOB_ERROR_CODES)[number];
export type GenerationJobError = { code: GenerationJobErrorCode; message: string };
export type CreditHoldRecord = { ownerId: string; ownerType: CreditHolderType.User | CreditHolderType.Organization; userId: string; organizationId: string | null; reservedCredits: number };
export type VideoJobOutput = { location: 'files' | 'generated'; s3Key: string; fileId?: string; contentType: string; bytes: number; durationSeconds: number };
export type VideoJobPayload = {
  request: VideoGenerationRequest;
  providerId: VideoProviderId;
  providerHandle?: { provider: string; data: Record<string, unknown> };
  providerOutput?: { kind: 'inline'; base64: string; contentType: string } | { kind: 'url'; url: string; requiresAuth: boolean; contentType?: string };
  reportedDurationSeconds?: number;
  output?: VideoJobOutput;
};
export interface IGenerationJob {
  kind: GenerationJobKind;           // one kind today; becomes a union of { kind, payload } pairs when a second kind lands
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  ownerId: string;
  requestedBy: string;
  source: GenerationJobSource;
  state: GenerationJobState;
  payload: VideoJobPayload;
  progress?: number;
  pollCount: number;
  attempts: number;
  cancelRequested: boolean;
  submitAttemptedAt?: Date | null;
  leaseUntil?: Date | null;
  nextPollAt?: Date | null;
  deadlineAt: Date;
  idempotencyKey?: string;
  creditHold: CreditHoldRecord | null;
  settledCredits?: number;
  error?: GenerationJobError;
  rawProviderError?: unknown;
  terminalHandlingClaimedAt?: Date | null;
  terminalHandledAt?: Date | null;
  questId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
export type IGenerationJobDocument = IGenerationJob & IMongoDocument;
export type GenerationJobCommit = Partial<Pick<IGenerationJob,
  'state' | 'payload' | 'progress' | 'pollCount' | 'attempts' | 'nextPollAt' | 'error' | 'rawProviderError' | 'settledCredits' | 'submitAttemptedAt'>>;
export interface IGenerationJobRepository extends IBaseRepository<IGenerationJobDocument> {
  createJob(input: Omit<IGenerationJob, 'createdAt' | 'updatedAt'>): Promise<IGenerationJobDocument>;
  findByIdempotencyKey(ownerType: IGenerationJob['ownerType'], ownerId: string, key: string): Promise<IGenerationJobDocument | null>;
  acquireLease(id: string, now: Date, leaseUntil: Date): Promise<IGenerationJobDocument | null>;
  markSubmitAttempted(id: string, at: Date): Promise<void>;
  commit(id: string, update: GenerationJobCommit): Promise<IGenerationJobDocument | null>;
  requestCancel(id: string): Promise<IGenerationJobDocument | null>;
  claimTerminalHandling(id: string, at: Date): Promise<boolean>;
  markTerminalHandled(id: string, at: Date): Promise<void>;
  findStalled(overdueBefore: Date, limit: number): Promise<IGenerationJobDocument[]>;
}
```

- [ ] **Step 1: Write the common types file** with exactly the declarations above (add the imports: `CreditHolderType`, `IMongoDocument`, `IBaseRepository` from their existing modules - copy the import lines from `DataLakeCorpusActionTypes.ts`; `VideoGenerationRequest`, `VideoProviderId` from `'../../video'`). Export it from `types/entities/index.ts` next to `DataLakeCorpusActionTypes`.

- [ ] **Step 2: Write the failing repository test**

`packages/database/src/models/ai/GenerationJobModel.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { CreditHolderType, type IGenerationJob } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { GenerationJobModel, generationJobRepository } from './GenerationJobModel';

const t0 = new Date('2026-10-06T00:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

const newJob = (overrides: Partial<IGenerationJob> = {}): Omit<IGenerationJob, 'createdAt' | 'updatedAt'> => ({
  kind: 'video',
  ownerType: CreditHolderType.User,
  ownerId: 'u1',
  requestedBy: 'u1',
  source: 'studio',
  state: 'pending',
  payload: {
    request: { model: 'test-video', mode: 'text_to_video', prompt: 'p', durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
    providerId: 'test',
  },
  pollCount: 0,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: plus(20 * 60_000),
  creditHold: null,
  ...overrides,
});

describe('GenerationJobRepository', () => {
  setupMongoTest();
  // setupMongoTest drops the database between tests, indexes included.
  beforeEach(async () => {
    await GenerationJobModel.ensureIndexes();
  });

  it('acquires a lease on a non-terminal job', async () => {
    const job = await generationJobRepository.createJob(newJob());
    const leased = await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    expect(leased?.id).toBe(job.id);
  });

  it('a second acquireLease while leased returns null', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    expect(await generationJobRepository.acquireLease(job.id, plus(1_000), plus(331_000))).toBeNull();
  });

  it('re-acquires once the lease has expired', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    expect(await generationJobRepository.acquireLease(job.id, plus(331_000), plus(661_000))).not.toBeNull();
  });

  it('commit clears the lease so the next step can run immediately', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    await generationJobRepository.commit(job.id, { state: 'running' });
    expect(await generationJobRepository.acquireLease(job.id, plus(1_000), plus(331_000))).not.toBeNull();
  });

  it('does not lease a terminal job whose terminal handling is done', async () => {
    const job = await generationJobRepository.createJob(newJob({ state: 'succeeded', terminalHandledAt: t0 }));
    expect(await generationJobRepository.acquireLease(job.id, t0, plus(330_000))).toBeNull();
  });

  it('leases a terminal job whose terminal handling never completed', async () => {
    const job = await generationJobRepository.createJob(newJob({ state: 'failed', terminalHandledAt: null }));
    expect(await generationJobRepository.acquireLease(job.id, t0, plus(330_000))).not.toBeNull();
  });

  it('claimTerminalHandling succeeds exactly once', async () => {
    const job = await generationJobRepository.createJob(newJob({ state: 'succeeded' }));
    expect(await generationJobRepository.claimTerminalHandling(job.id, t0)).toBe(true);
    expect(await generationJobRepository.claimTerminalHandling(job.id, plus(1))).toBe(false);
  });

  it('enforces one idempotency key per owner', async () => {
    await generationJobRepository.createJob(newJob({ idempotencyKey: 'k1' }));
    await expect(generationJobRepository.createJob(newJob({ idempotencyKey: 'k1' }))).rejects.toMatchObject({ code: 11000 });
    await expect(generationJobRepository.createJob(newJob({ idempotencyKey: 'k1', ownerId: 'u2' }))).resolves.toBeTruthy();
  });

  it('findStalled returns overdue non-terminal jobs and unhandled, unclaimed terminal jobs', async () => {
    const overdue = await generationJobRepository.createJob(newJob({ state: 'running', nextPollAt: t0 }));
    await generationJobRepository.createJob(newJob({ state: 'running', nextPollAt: plus(10 * 60_000) }));
    const unhandled = await generationJobRepository.createJob(newJob({ state: 'succeeded', terminalHandledAt: null }));
    await GenerationJobModel.updateOne({ _id: unhandled.id }, { $set: { updatedAt: t0 } }, { timestamps: false });
    const ids = (await generationJobRepository.findStalled(plus(60_000), 50)).map(j => j.id).sort();
    expect(ids).toEqual([overdue.id, unhandled.id].sort());
  });

  it('hides rawProviderError by default', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.commit(job.id, { rawProviderError: { secret: 'provider payload' } });
    const found = await generationJobRepository.findById(job.id);
    expect((found as Record<string, unknown>).rawProviderError).toBeUndefined();
  });
});
```

Note the memory gotcha: `{ timestamps: false }` on an update is ignored by Mongoose in some code paths; if the `findStalled` test cannot backdate `updatedAt` that way, use `GenerationJobModel.collection.updateOne(...)` (raw driver) instead.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm turbo:core:build && pnpm --filter @bike4mind/database exec vitest run src/models/ai/GenerationJobModel.test.ts`
Expected: FAIL - `Cannot find module './GenerationJobModel'`.

- [ ] **Step 4: Implement the model and repository** (follow `DataLakeCorpusActionModel.ts` layout)

```ts
import mongoose, { Model, Schema } from 'mongoose';
import {
  CreditHolderType,
  GENERATION_JOB_KINDS,
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobCommit,
  type IGenerationJob,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'GenerationJob';
interface IGenerationJobModel extends Model<IGenerationJobDocument> {}

const GenerationJobSchema = new Schema<IGenerationJobDocument>(
  {
    kind: { type: String, enum: [...GENERATION_JOB_KINDS], required: true },
    ownerType: { type: String, enum: [CreditHolderType.User, CreditHolderType.Organization], required: true },
    ownerId: { type: String, required: true },
    requestedBy: { type: String, required: true },
    source: { type: String, enum: [...GENERATION_JOB_SOURCES], required: true },
    state: { type: String, enum: [...GENERATION_JOB_STATES], required: true },
    // Kind-specific; validated by the kind's Zod schemas at the service boundary, not by Mongoose.
    payload: { type: Schema.Types.Mixed, required: true },
    progress: { type: Number },
    pollCount: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    submitAttemptedAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    nextPollAt: { type: Date, default: null },
    deadlineAt: { type: Date, required: true },
    idempotencyKey: { type: String },
    creditHold: { type: Schema.Types.Mixed, default: null },
    settledCredits: { type: Number },
    error: new Schema({ code: { type: String, required: true }, message: { type: String, required: true } }, { _id: false }),
    // Raw provider payloads can be large and are never returned to clients.
    rawProviderError: { type: Schema.Types.Mixed, select: false },
    terminalHandlingClaimedAt: { type: Date, default: null },
    terminalHandledAt: { type: Date, default: null },
    questId: { type: String },
  },
  { timestamps: true, versionKey: false, minimize: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

GenerationJobSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
GenerationJobSchema.index({ state: 1, nextPollAt: 1 });
GenerationJobSchema.index({ state: 1, terminalHandledAt: 1, updatedAt: 1 });
GenerationJobSchema.index(
  { ownerType: 1, ownerId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const GenerationJobModel: IGenerationJobModel =
  (mongoose.models[ModelName] as IGenerationJobModel) ||
  mongoose.model<IGenerationJobDocument, IGenerationJobModel>(ModelName, GenerationJobSchema);

const NON_TERMINAL = GENERATION_JOB_STATES.filter(s => !TERMINAL_GENERATION_JOB_STATES.includes(s));
const toJob = (doc: { toJSON(): unknown } | null) => (doc ? (doc.toJSON() as IGenerationJobDocument) : null);

class GenerationJobRepository extends BaseRepository<IGenerationJobDocument> implements IGenerationJobRepository {
  constructor(private jobModel: mongoose.Model<IGenerationJobDocument>) {
    super(jobModel);
  }

  async createJob(input: Omit<IGenerationJob, 'createdAt' | 'updatedAt'>) {
    const doc = await this.jobModel.create(input);
    return doc.toJSON() as IGenerationJobDocument;
  }

  async findByIdempotencyKey(ownerType: IGenerationJob['ownerType'], ownerId: string, key: string) {
    return toJob(await this.jobModel.findOne({ ownerType, ownerId, idempotencyKey: key }));
  }

  // Leasable: unleased (or lease expired) and either still running or terminal with handling not done.
  async acquireLease(id: string, now: Date, leaseUntil: Date) {
    return toJob(
      await this.jobModel.findOneAndUpdate(
        {
          _id: id,
          $and: [
            { $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
            { $or: [{ state: { $in: NON_TERMINAL } }, { terminalHandledAt: null }] },
          ],
        },
        { $set: { leaseUntil } },
        { new: true }
      )
    );
  }

  async markSubmitAttempted(id: string, at: Date) {
    await this.jobModel.updateOne({ _id: id }, { $set: { submitAttemptedAt: at } });
  }

  // Every engine step ends here: one write that applies the step's result and releases the lease.
  async commit(id: string, update: GenerationJobCommit) {
    return toJob(await this.jobModel.findOneAndUpdate({ _id: id }, { $set: { ...update, leaseUntil: null } }, { new: true }));
  }

  async requestCancel(id: string) {
    return toJob(
      await this.jobModel.findOneAndUpdate({ _id: id, state: { $in: NON_TERMINAL } }, { $set: { cancelRequested: true } }, { new: true })
    );
  }

  async claimTerminalHandling(id: string, at: Date) {
    const result = await this.jobModel.updateOne(
      { _id: id, state: { $in: TERMINAL_GENERATION_JOB_STATES }, terminalHandlingClaimedAt: null },
      { $set: { terminalHandlingClaimedAt: at } }
    );
    return result.modifiedCount === 1;
  }

  async markTerminalHandled(id: string, at: Date) {
    await this.jobModel.updateOne({ _id: id }, { $set: { terminalHandledAt: at } });
  }

  async findStalled(overdueBefore: Date, limit: number) {
    const docs = await this.jobModel
      .find({
        $or: [
          { state: { $in: NON_TERMINAL }, nextPollAt: { $lt: overdueBefore } },
          {
            state: { $in: TERMINAL_GENERATION_JOB_STATES },
            terminalHandledAt: null,
            terminalHandlingClaimedAt: null,
            updatedAt: { $lt: overdueBefore },
          },
        ],
      })
      .limit(limit);
    return docs.map(d => d.toJSON() as IGenerationJobDocument);
  }
}

export const generationJobRepository = new GenerationJobRepository(GenerationJobModel);
```

Export from `packages/database/src/models/ai/index.ts`: `export * from './GenerationJobModel';`.

Note: jobs created in `pending` have `nextPollAt: null` and are not found by `findStalled`; Task 8's `createVideoJob` sets `nextPollAt: now` at creation so a lost first message is also swept.

- [ ] **Step 5: Run repository tests**

Run: `pnpm turbo:core:build && pnpm --filter @bike4mind/database exec vitest run src/models/ai/GenerationJobModel.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Add the ensure-indexes migration**

`packages/scripts/migrate/migrations/20260923000000_ensure-generation-job-indexes.ts`:

```ts
import { GenerationJobModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

// Built here rather than by autoIndex: DocumentDB takes a foreground lock and autoIndex is fire-and-forget.
const migration: MigrationFile = {
  id: 20260923000000,
  name: 'ensure generation job indexes',
  up: async () => {
    await GenerationJobModel.createIndexes();
  },
  down: async () => {
    /* nothing to reverse */
  },
};
export default migration;
```

Register it in `migrations/index.ts` (import next to `EnsureDataLakeCorpusActionIndexes` at ~L134, array entry in id order after `20260922000001` at ~L273). Confirm the id is unique and greater than every existing id, including `premium.generated.ts`: `grep -rho "id: 2026[0-9]*" packages/scripts/migrate/migrations | sort | tail -3`.

Run: `pnpm --filter @bike4mind/scripts exec vitest run migrate` (or the package's migration test that checks duplicate ids; find it with `grep -rln "duplicate" packages/scripts/migrate`).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add b4m-core/common/src/types/entities packages/database/src/models/ai packages/scripts/migrate/migrations
git commit -m "feat(video): add the GenerationJob model and repository"
```

---

### Task 6: Generic generation-job engine and sweeper

**Files:**
- Create: `b4m-core/services/src/generationJobs/types.ts`, `backoff.ts`, `engine.ts`, `sweep.ts`, `index.ts`
- Create: `b4m-core/services/src/generationJobs/engine.test.ts`, `backoff.test.ts`, `sweep.test.ts`, `__test__/inMemoryGenerationJobRepository.ts`
- Modify: `b4m-core/services/package.json` (add `./generationJobs` subpath export, copying the `./creditService` entry shape at `:53`)

**Interfaces:**
- Consumes: `IGenerationJobRepository`, `IGenerationJobDocument`, `GenerationJobCommit`, `GenerationJobError`, `GenerationJobKind`, `TERMINAL_GENERATION_JOB_STATES` (Task 5); `ProviderSubmitError` (Task 4, `@bike4mind/utils/videoProviders`); `Logger`.
- Produces (verbatim):

```ts
export type StepResult =
  | { next: 'running'; payload: IGenerationJob['payload'] }          // submit accepted
  | { next: 'poll_again'; progress?: number }
  | { next: 'storing'; payload: IGenerationJob['payload'] }          // provider finished
  | { next: 'succeeded'; payload: IGenerationJob['payload'] }
  | { next: 'failed'; error: GenerationJobError; rawProviderError?: unknown }
  | { next: 'blocked'; error: GenerationJobError; rawProviderError?: unknown }
  | { next: 'retry'; reason: string };                               // transient; same state, backoff
export type GenerationJobHandler = {
  kind: GenerationJobKind;
  maxWallClockMs: number;
  submit(job: IGenerationJobDocument): Promise<StepResult>;
  poll(job: IGenerationJobDocument): Promise<StepResult>;
  store(job: IGenerationJobDocument): Promise<StepResult>;
  cancelAtProvider(job: IGenerationJobDocument): Promise<void>;
  onTerminal(job: IGenerationJobDocument): Promise<void>;   // must tolerate being the only call (engine guarantees at most once)
};
export type GenerationJobEngineDeps = {
  repository: IGenerationJobRepository;
  handlers: readonly GenerationJobHandler[];
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  notify(job: IGenerationJobDocument): Promise<void>;
  now(): Date;
  logger: Logger;
  leaseMs: number;
};
export type StepOutcome = 'skipped' | 'advanced' | 'terminal';
export class GenerationJobEngine {
  constructor(deps: GenerationJobEngineDeps);
  step(jobId: string): Promise<StepOutcome>;
  requestCancel(jobId: string): Promise<IGenerationJobDocument | null>;
}
export const POLL_BACKOFF_SECONDS: readonly number[];   // [5, 10, 20, 30, 60]
export const MAX_STEP_ATTEMPTS = 5;
export function pollDelaySeconds(pollCount: number): number;
export function runGenerationJobSweep(deps: { repository: IGenerationJobRepository; enqueue(jobId: string, delaySeconds: number): Promise<void>; now(): Date; logger: Logger }, options?: { overdueMs?: number; limit?: number }): Promise<{ requeued: number }>;
```

- [ ] **Step 1: Write `backoff.ts` with its test**

```ts
// backoff.ts
export const POLL_BACKOFF_SECONDS = [5, 10, 20, 30, 60] as const;
export const MAX_STEP_ATTEMPTS = 5;

export const pollDelaySeconds = (pollCount: number): number =>
  POLL_BACKOFF_SECONDS[Math.min(Math.max(pollCount, 0), POLL_BACKOFF_SECONDS.length - 1)];
```

```ts
// backoff.test.ts
import { describe, expect, it } from 'vitest';
import { pollDelaySeconds } from './backoff';

describe('pollDelaySeconds', () => {
  it.each([[0, 5], [1, 10], [2, 20], [3, 30], [4, 60], [50, 60], [-1, 5]])('poll %i waits %is', (n, s) => {
    expect(pollDelaySeconds(n)).toBe(s);
  });
});
```

- [ ] **Step 2: Write the in-memory repository used by engine tests**

`__test__/inMemoryGenerationJobRepository.ts` implements `IGenerationJobRepository` over a `Map`, with the same lease / claim / stalled semantics as Task 5 (the Mongo semantics are pinned by Task 5's tests; this fake lets engine tests run without Mongo and simulate crashes). Implement only the interface methods the engine and sweeper call; for `IBaseRepository` methods other than `findById`, throw `new Error('not used by engine tests')`, typed via a cast on the returned object (`as unknown as IGenerationJobRepository`) so the fake does not need to implement the whole base.

```ts
import { TERMINAL_GENERATION_JOB_STATES, type GenerationJobCommit, type IGenerationJob, type IGenerationJobDocument, type IGenerationJobRepository } from '@bike4mind/common';

export const createInMemoryGenerationJobRepository = () => {
  const jobs = new Map<string, IGenerationJobDocument>();
  let seq = 0;
  const isTerminal = (j: IGenerationJob) => TERMINAL_GENERATION_JOB_STATES.includes(j.state);
  const repo = {
    jobs,
    async createJob(input: Omit<IGenerationJob, 'createdAt' | 'updatedAt'>) {
      const id = `job${++seq}`;
      const doc = { ...input, id, _id: id, createdAt: new Date(), updatedAt: new Date() } as unknown as IGenerationJobDocument;
      jobs.set(id, doc);
      return structuredClone(doc);
    },
    async findById(id: string) {
      const j = jobs.get(id);
      return j ? structuredClone(j) : null;
    },
    async findByIdempotencyKey(ownerType: IGenerationJob['ownerType'], ownerId: string, key: string) {
      return [...jobs.values()].find(j => j.ownerType === ownerType && j.ownerId === ownerId && j.idempotencyKey === key) ?? null;
    },
    async acquireLease(id: string, now: Date, leaseUntil: Date) {
      const j = jobs.get(id);
      if (!j) return null;
      const free = !j.leaseUntil || j.leaseUntil < now;
      const leasable = !isTerminal(j) || !j.terminalHandledAt;
      if (!free || !leasable) return null;
      j.leaseUntil = leaseUntil;
      return structuredClone(j);
    },
    async markSubmitAttempted(id: string, at: Date) {
      jobs.get(id)!.submitAttemptedAt = at;
    },
    async commit(id: string, update: GenerationJobCommit) {
      const j = jobs.get(id);
      if (!j) return null;
      Object.assign(j, update, { leaseUntil: null, updatedAt: new Date() });
      return structuredClone(j);
    },
    async requestCancel(id: string) {
      const j = jobs.get(id);
      if (!j || isTerminal(j)) return null;
      j.cancelRequested = true;
      return structuredClone(j);
    },
    async claimTerminalHandling(id: string, at: Date) {
      const j = jobs.get(id);
      if (!j || !isTerminal(j) || j.terminalHandlingClaimedAt) return false;
      j.terminalHandlingClaimedAt = at;
      return true;
    },
    async markTerminalHandled(id: string, at: Date) {
      jobs.get(id)!.terminalHandledAt = at;
    },
    async findStalled(overdueBefore: Date, limit: number) {
      return [...jobs.values()]
        .filter(j =>
          isTerminal(j)
            ? !j.terminalHandledAt && !j.terminalHandlingClaimedAt && (j.updatedAt ?? new Date(0)) < overdueBefore
            : !!j.nextPollAt && j.nextPollAt < overdueBefore
        )
        .slice(0, limit)
        .map(j => structuredClone(j));
    },
  };
  return repo as typeof repo & IGenerationJobRepository;
};
```

- [ ] **Step 3: Write the failing engine tests**

`engine.test.ts` drives a scripted handler (each method returns the next queued result or throws) through the in-memory repo:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IGenerationJob } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ProviderSubmitError } from '@bike4mind/utils/videoProviders';
import { createInMemoryGenerationJobRepository } from './__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from './engine';
import type { GenerationJobHandler, StepResult } from './types';

const payload = {
  request: { model: 'test-video', mode: 'text_to_video', prompt: 'p', durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
  providerId: 'test',
} as IGenerationJob['payload'];

const setup = () => {
  let clock = new Date('2026-10-06T00:00:00Z');
  const repository = createInMemoryGenerationJobRepository();
  const enqueue = vi.fn(async (_jobId: string, _delay: number) => undefined);
  const notify = vi.fn(async () => undefined);
  const results: Record<'submit' | 'poll' | 'store', Array<StepResult | Error>> = { submit: [], poll: [], store: [] };
  const take = (step: 'submit' | 'poll' | 'store') => async () => {
    const next = results[step].shift();
    if (!next) throw new Error(`no scripted ${step} result`);
    if (next instanceof Error) throw next;
    return next;
  };
  const handler: GenerationJobHandler = {
    kind: 'video',
    maxWallClockMs: 20 * 60_000,
    submit: vi.fn(take('submit')),
    poll: vi.fn(take('poll')),
    store: vi.fn(take('store')),
    cancelAtProvider: vi.fn(async () => undefined),
    onTerminal: vi.fn(async () => undefined),
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [handler],
    enqueue,
    notify,
    now: () => clock,
    logger: new Logger({ metadata: { test: 'engine' } }),
    leaseMs: 330_000,
  });
  const create = (overrides: Partial<IGenerationJob> = {}) =>
    repository.createJob({
      kind: 'video', ownerType: CreditHolderType.User, ownerId: 'u1', requestedBy: 'u1', source: 'studio',
      state: 'pending', payload, pollCount: 0, attempts: 0, cancelRequested: false,
      deadlineAt: new Date(clock.getTime() + 20 * 60_000), creditHold: null, ...overrides,
    });
  return { engine, repository, handler, enqueue, notify, results, create, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
};

describe('GenerationJobEngine', () => {
  it('runs submit -> poll -> store -> succeeded, one step per message, then settles once', async () => {
    const t = setup();
    const job = await t.create();
    t.results.submit.push({ next: 'running', payload: { ...payload, providerHandle: { provider: 'test', data: {} } } });
    t.results.poll.push({ next: 'poll_again', progress: 0.5 }, { next: 'storing', payload });
    t.results.store.push({ next: 'succeeded', payload });

    expect(await t.engine.step(job.id)).toBe('advanced');      // submit
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 5);
    expect(await t.engine.step(job.id)).toBe('advanced');      // poll: still running
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 10);
    expect(await t.engine.step(job.id)).toBe('advanced');      // poll: done
    expect(await t.engine.step(job.id)).toBe('terminal');      // store

    const final = t.repository.jobs.get(job.id)!;
    expect(final.state).toBe('succeeded');
    expect(final.terminalHandledAt).toBeTruthy();
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalled();
  });

  it('duplicate message while leased is a no-op', async () => {
    const t = setup();
    const job = await t.create();
    await t.repository.acquireLease(job.id, new Date('2026-10-06T00:00:00Z'), new Date('2026-10-06T00:05:30Z'));
    expect(await t.engine.step(job.id)).toBe('skipped');
    expect(t.handler.submit).not.toHaveBeenCalled();
  });

  it('marks the submit attempt before calling the provider', async () => {
    const t = setup();
    const job = await t.create();
    (t.handler.submit as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      expect(t.repository.jobs.get(job.id)!.submitAttemptedAt).toBeTruthy();
      return { next: 'running', payload } satisfies StepResult;
    });
    await t.engine.step(job.id);
  });

  it('a pending job with a submit attempt already recorded fails as orphaned_submit without resubmitting', async () => {
    const t = setup();
    const job = await t.create({ submitAttemptedAt: new Date('2026-10-05T23:59:00Z') });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.handler.submit).not.toHaveBeenCalled();
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('orphaned_submit');
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
  });

  it('a submit with an unknown outcome fails as orphaned_submit immediately', async () => {
    const t = setup();
    const job = await t.create();
    t.results.submit.push(new Error('socket hang up'));
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('orphaned_submit');
  });

  it('a definitive submit rejection clears the attempt and retries with backoff', async () => {
    const t = setup();
    const job = await t.create();
    t.results.submit.push(new ProviderSubmitError('429', true));
    expect(await t.engine.step(job.id)).toBe('advanced');
    const after = t.repository.jobs.get(job.id)!;
    expect(after.state).toBe('pending');
    expect(after.submitAttemptedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 5);
  });

  it('fails with provider_error after MAX_STEP_ATTEMPTS transient retries', async () => {
    const t = setup();
    const job = await t.create({ state: 'running', attempts: 4 });
    t.results.poll.push({ next: 'retry', reason: 'HTTP 503' });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('provider_error');
  });

  it('an unexpected throw in poll is treated as a transient retry', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    t.results.poll.push(new Error('ECONNRESET'));
    expect(await t.engine.step(job.id)).toBe('advanced');
    expect(t.repository.jobs.get(job.id)!.attempts).toBe(1);
  });

  it('fails with provider_timeout past the deadline and cancels at the provider', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    t.advance(21 * 60_000);
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('provider_timeout');
    expect(t.handler.cancelAtProvider).toHaveBeenCalled();
  });

  it('blocked is terminal with content_blocked and still runs onTerminal', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    t.results.poll.push({ next: 'blocked', error: { code: 'content_blocked', message: 'policy' }, rawProviderError: { x: 1 } });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.state).toBe('blocked');
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'running'] as const)('cancel requested while %s cancels', async state => {
    const t = setup();
    const job = await t.create({ state });
    await t.engine.requestCancel(job.id);
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.state).toBe('cancelled');
    expect(t.handler.cancelAtProvider).toHaveBeenCalledTimes(state === 'running' ? 1 : 0);
  });

  it('cancel requested while storing is ignored: the result is already paid for', async () => {
    const t = setup();
    const job = await t.create({ state: 'storing', cancelRequested: true });
    t.results.store.push({ next: 'succeeded', payload });
    await t.engine.step(job.id);
    expect(t.repository.jobs.get(job.id)!.state).toBe('succeeded');
  });

  it('re-runs onTerminal for a terminal job left unhandled', async () => {
    const t = setup();
    const job = await t.create({ state: 'failed', error: { code: 'provider_error', message: 'x' } });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
    expect(t.repository.jobs.get(job.id)!.terminalHandledAt).toBeTruthy();
  });

  it('onTerminal is never run twice, even if the first run crashed after claiming', async () => {
    const t = setup();
    const job = await t.create({ state: 'failed', error: { code: 'provider_error', message: 'x' } });
    (t.handler.onTerminal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    await expect(t.engine.step(job.id)).rejects.toThrow('db down');
    t.advance(400_000);
    expect(await t.engine.step(job.id)).toBe('skipped');
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
  });

  it('a notify failure never fails the step', async () => {
    const t = setup();
    const job = await t.create();
    t.notify.mockRejectedValue(new Error('ws down'));
    t.results.submit.push({ next: 'running', payload });
    await expect(t.engine.step(job.id)).resolves.toBe('advanced');
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm --filter @bike4mind/services exec vitest run src/generationJobs`
Expected: FAIL - `Cannot find module './engine'`.

- [ ] **Step 5: Implement `types.ts` and `engine.ts`**

`types.ts` contains exactly the `StepResult`, `GenerationJobHandler`, `GenerationJobEngineDeps` and `StepOutcome` declarations from the Interfaces block.

`engine.ts`:

```ts
import {
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobCommit,
  type GenerationJobError,
  type GenerationJobState,
  type IGenerationJobDocument,
} from '@bike4mind/common';
import { ProviderSubmitError } from '@bike4mind/utils/videoProviders';
import { MAX_STEP_ATTEMPTS, pollDelaySeconds } from './backoff';
import type { GenerationJobEngineDeps, GenerationJobHandler, StepOutcome, StepResult } from './types';

const isTerminal = (state: GenerationJobState) => TERMINAL_GENERATION_JOB_STATES.includes(state);

/**
 * Advances a job exactly one step per call. Safe under duplicate, delayed and reordered delivery:
 * the lease admits one worker at a time and every step ends in a single commit that releases it.
 * Credit settlement (onTerminal) runs at most once via claimTerminalHandling.
 */
export class GenerationJobEngine {
  private readonly handlers: Map<string, GenerationJobHandler>;

  constructor(private readonly deps: GenerationJobEngineDeps) {
    this.handlers = new Map(deps.handlers.map(h => [h.kind, h]));
  }

  requestCancel(jobId: string) {
    return this.deps.repository.requestCancel(jobId).then(async job => {
      if (job) await this.deps.enqueue(job.id, 0);
      return job;
    });
  }

  async step(jobId: string): Promise<StepOutcome> {
    const now = this.deps.now();
    const job = await this.deps.repository.acquireLease(jobId, now, new Date(now.getTime() + this.deps.leaseMs));
    if (!job) return 'skipped';
    const handler = this.handlers.get(job.kind);
    if (!handler) throw new Error(`no generation job handler registered for kind '${job.kind}'`);

    if (isTerminal(job.state)) return this.finishTerminal(job, handler);

    if (job.cancelRequested && job.state !== 'storing') {
      if (job.state === 'running') await this.bestEffortCancel(job, handler);
      return this.toTerminal(job, handler, { state: 'cancelled', error: { code: 'cancelled', message: 'Cancelled by the user' } });
    }
    if (now > job.deadlineAt) {
      if (job.state === 'running') await this.bestEffortCancel(job, handler);
      return this.toTerminal(job, handler, {
        state: 'failed',
        error: { code: 'provider_timeout', message: 'The provider did not finish in time' },
      });
    }

    const result = await this.runStep(job, handler);
    return this.apply(job, handler, result);
  }

  private async runStep(job: IGenerationJobDocument, handler: GenerationJobHandler): Promise<StepResult> {
    if (job.state === 'pending') {
      if (job.submitAttemptedAt) return orphaned('A previous submit attempt ended without a recorded provider job');
      await this.deps.repository.markSubmitAttempted(job.id, this.deps.now());
      try {
        return await handler.submit(job);
      } catch (error) {
        if (error instanceof ProviderSubmitError && error.definitive) {
          return { next: 'retry', reason: `submit rejected: ${error.message}` };
        }
        this.deps.logger.error('generation_job_orphaned_submit', { jobId: job.id, kind: job.kind, error });
        return orphaned('The provider submit ended with an unknown outcome');
      }
    }
    try {
      return job.state === 'running' ? await handler.poll(job) : await handler.store(job);
    } catch (error) {
      this.deps.logger.warn('generation job step threw; retrying', { jobId: job.id, state: job.state, error });
      return { next: 'retry', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async apply(job: IGenerationJobDocument, handler: GenerationJobHandler, result: StepResult): Promise<StepOutcome> {
    switch (result.next) {
      case 'running':
      case 'storing':
        return this.advance(job, { state: result.next, payload: result.payload, attempts: 0, pollCount: 0 }, result.next === 'storing' ? 0 : pollDelaySeconds(0));
      case 'poll_again':
        return this.advance(job, { progress: result.progress, pollCount: job.pollCount + 1 }, pollDelaySeconds(job.pollCount + 1));
      case 'retry': {
        const attempts = job.attempts + 1;
        if (attempts >= MAX_STEP_ATTEMPTS) {
          return this.toTerminal(job, handler, { state: 'failed', error: { code: 'provider_error', message: result.reason } });
        }
        // A definitive submit rejection created nothing at the provider, so the next submit is safe.
        const clearSubmit = job.state === 'pending' ? { submitAttemptedAt: null } : {};
        return this.advance(job, { attempts, ...clearSubmit }, pollDelaySeconds(attempts - 1));
      }
      case 'succeeded':
        return this.toTerminal(job, handler, { state: 'succeeded', payload: result.payload, progress: 1 });
      case 'failed':
      case 'blocked':
        return this.toTerminal(job, handler, { state: result.next, error: result.error, rawProviderError: result.rawProviderError });
    }
  }

  private async advance(job: IGenerationJobDocument, update: GenerationJobCommit, delaySeconds: number): Promise<StepOutcome> {
    const nextPollAt = new Date(this.deps.now().getTime() + delaySeconds * 1000);
    const committed = await this.deps.repository.commit(job.id, { ...update, nextPollAt });
    await this.deps.enqueue(job.id, delaySeconds);
    await this.safeNotify(committed);
    return 'advanced';
  }

  private async toTerminal(job: IGenerationJobDocument, handler: GenerationJobHandler, update: GenerationJobCommit & { error?: GenerationJobError }): Promise<StepOutcome> {
    const committed = await this.deps.repository.commit(job.id, { ...update, nextPollAt: null });
    if (!committed) return 'skipped';
    return this.finishTerminal(committed, handler);
  }

  private async finishTerminal(job: IGenerationJobDocument, handler: GenerationJobHandler): Promise<StepOutcome> {
    const claimed = await this.deps.repository.claimTerminalHandling(job.id, this.deps.now());
    if (!claimed) {
      // Another run claimed settlement and crashed mid-way; never risk settling twice. Alarmed for manual repair.
      this.deps.logger.error('generation_job_terminal_handling_stuck', { jobId: job.id, kind: job.kind });
      await this.deps.repository.commit(job.id, {});
      return 'skipped';
    }
    await handler.onTerminal(job);
    await this.deps.repository.markTerminalHandled(job.id, this.deps.now());
    await this.deps.repository.commit(job.id, {});
    await this.safeNotify(job);
    return 'terminal';
  }

  private async bestEffortCancel(job: IGenerationJobDocument, handler: GenerationJobHandler) {
    try {
      await handler.cancelAtProvider(job);
    } catch (error) {
      this.deps.logger.warn('provider cancel failed; the provider job may still complete and be discarded', { jobId: job.id, error });
    }
  }

  private async safeNotify(job: IGenerationJobDocument | null) {
    if (!job) return;
    try {
      await this.deps.notify(job);
    } catch (error) {
      this.deps.logger.warn('generation job notify failed', { jobId: job.id, error });
    }
  }
}

const orphaned = (message: string): StepResult => ({ next: 'failed', error: { code: 'orphaned_submit', message } });
```

Wait - the "onTerminal is never run twice" test expects the second step to return `'skipped'` after the first threw post-claim. With the code above, the first call claims, `onTerminal` throws, the lease is still held (no commit), and the step rethrows. After the lease expires, the second step leases (terminal, unhandled), `claimTerminalHandling` returns false, logs `generation_job_terminal_handling_stuck`, releases the lease and returns `'skipped'`. That matches. Keep the test.

`index.ts`:

```ts
export * from './types';
export * from './backoff';
export * from './engine';
export * from './sweep';
```

- [ ] **Step 6: Run engine tests**

Run: `pnpm --filter @bike4mind/services exec vitest run src/generationJobs`
Expected: PASS (all engine + backoff tests). If `@bike4mind/utils/videoProviders` does not resolve, add the subpath export from Task 4 and run `pnpm turbo:core:build`.

- [ ] **Step 7: Write the failing sweep test, then implement `sweep.ts`**

```ts
// sweep.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from './__test__/inMemoryGenerationJobRepository';
import { runGenerationJobSweep } from './sweep';

describe('runGenerationJobSweep', () => {
  it('re-enqueues overdue jobs immediately and leaves on-schedule jobs alone', async () => {
    const now = new Date('2026-10-06T01:00:00Z');
    const repository = createInMemoryGenerationJobRepository();
    const base = {
      kind: 'video', ownerType: CreditHolderType.User, ownerId: 'u1', requestedBy: 'u1', source: 'studio',
      payload: {} as never, pollCount: 0, attempts: 0, cancelRequested: false, deadlineAt: now, creditHold: null,
    } as const;
    const overdue = await repository.createJob({ ...base, state: 'running', nextPollAt: new Date('2026-10-06T00:50:00Z') });
    await repository.createJob({ ...base, state: 'running', nextPollAt: new Date('2026-10-06T00:59:00Z') });
    const enqueue = vi.fn(async () => undefined);
    const result = await runGenerationJobSweep({ repository, enqueue, now: () => now, logger: new Logger({ metadata: {} }) });
    expect(result).toEqual({ requeued: 1 });
    expect(enqueue).toHaveBeenCalledWith(overdue.id, 0);
  });
});
```

```ts
// sweep.ts
import type { IGenerationJobRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

export const SWEEP_OVERDUE_MS = 5 * 60_000;
const SWEEP_LIMIT = 200;

// Recovers jobs whose SQS message was lost or whose worker died mid-step; the engine's lease makes a spurious re-enqueue harmless.
export async function runGenerationJobSweep(
  deps: { repository: IGenerationJobRepository; enqueue(jobId: string, delaySeconds: number): Promise<void>; now(): Date; logger: Logger },
  options: { overdueMs?: number; limit?: number } = {}
): Promise<{ requeued: number }> {
  const overdueBefore = new Date(deps.now().getTime() - (options.overdueMs ?? SWEEP_OVERDUE_MS));
  const stalled = await deps.repository.findStalled(overdueBefore, options.limit ?? SWEEP_LIMIT);
  for (const job of stalled) {
    await deps.enqueue(job.id, 0);
  }
  if (stalled.length > 0) deps.logger.warn('generation job sweep re-enqueued stalled jobs', { count: stalled.length });
  return { requeued: stalled.length };
}
```

Run: `pnpm --filter @bike4mind/services exec vitest run src/generationJobs`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm --filter @bike4mind/services typecheck`
Expected: clean.

```bash
git add b4m-core/services/src/generationJobs b4m-core/services/package.json
git commit -m "feat(video): add the generic generation-job engine and sweeper"
```

---

### Task 7: Websocket action and admin setting

**Files:**
- Modify: `b4m-core/common/src/schemas/actions.ts` (new action schema near `:349`; add it to the `MessageDataToClient` discriminated union at `:1555`)
- Modify: `b4m-core/common/src/schemas/settings.ts` (key in `SettingKeySchema` at `:254`; schema + type near the other object-setting schemas, e.g. after `RapidReplySettingsSchema` at `:1055`; registry entry in `settingsMap` near `orchestrationDefaults` at `:4759`)
- Test: `b4m-core/common/src/schemas/videoGenerationSetting.test.ts`, and add a case to an existing actions test if one parses `MessageDataToClient` (find with `grep -rln "MessageDataToClient" b4m-core/common/src --include='*.test.ts'`)

**Interfaces:**
- Produces:

```ts
export const GenerationJobUpdatedAction = z.object({
  action: z.literal('generation_job_updated'),
  job: z.object({
    id: z.string(),
    kind: z.enum(GENERATION_JOB_KINDS),
    state: z.enum(GENERATION_JOB_STATES),
    progress: z.number().min(0).max(1).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    output: z.object({ fileId: z.string().optional(), contentType: z.string(), durationSeconds: z.number() }).optional(),
  }),
});
export const VideoGenerationSettingsSchema = z.object({ enabledModels: z.record(z.string(), z.boolean()).prefault({}) });
export type VideoGenerationSettings = z.infer<typeof VideoGenerationSettingsSchema>;
export function isVideoModelEnabled(id: VideoModelId, settings: VideoGenerationSettings | undefined): boolean;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MessageDataToClient } from './actions';
import { isVideoModelEnabled, settingsMap, VideoGenerationSettingsSchema } from './settings';

describe('videoGeneration admin setting', () => {
  it('defaults to an empty override map', () => {
    expect(VideoGenerationSettingsSchema.parse({})).toEqual({ enabledModels: {} });
    expect(settingsMap.videoGeneration.defaultValue).toEqual({ enabledModels: {} });
  });

  it('falls back to the catalog default when no override exists', () => {
    expect(isVideoModelEnabled('test-video', undefined)).toBe(true);
  });

  it('an override wins over the catalog default', () => {
    expect(isVideoModelEnabled('test-video', { enabledModels: { 'test-video': false } })).toBe(false);
  });
});

describe('generation_job_updated action', () => {
  it('parses through the client message union', () => {
    const parsed = MessageDataToClient.parse({
      action: 'generation_job_updated',
      job: { id: 'j1', kind: 'video', state: 'running', progress: 0.5 },
    });
    expect(parsed.action).toBe('generation_job_updated');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bike4mind/common exec vitest run src/schemas/videoGenerationSetting.test.ts`
Expected: FAIL - `isVideoModelEnabled` not exported.

- [ ] **Step 3: Implement**

In `actions.ts`, add `GenerationJobUpdatedAction` (as above; import `GENERATION_JOB_KINDS`, `GENERATION_JOB_STATES` from `'../types/entities/GenerationJobTypes'`) and include it in the `MessageDataToClient` union list.

In `settings.ts`:

```ts
export const VideoGenerationSettingsSchema = z.object({
  // Per-model override of VIDEO_MODEL_CATALOG[id].defaultEnabled.
  enabledModels: z.record(z.string(), z.boolean()).prefault({}),
});
export type VideoGenerationSettings = z.infer<typeof VideoGenerationSettingsSchema>;

export const isVideoModelEnabled = (id: VideoModelId, settings: VideoGenerationSettings | undefined): boolean =>
  settings?.enabledModels[id] ?? VIDEO_MODEL_CATALOG[id].defaultEnabled;
```

Add `'videoGeneration'` to `SettingKeySchema`, and in `settingsMap`:

```ts
  videoGeneration: makeObjectSetting({
    key: 'videoGeneration',
    name: 'Video Generation',
    defaultValue: VideoGenerationSettingsSchema.parse({}),
    description: 'Enable or disable individual video generation models. Models without an override use their built-in default.',
    category: 'AI',
    order: 150,
    schema: VideoGenerationSettingsSchema,
  }),
```

Check `orchestrationDefaults` (`:4759`) for any other required fields (`userReadable`, `group`) and mirror them. Import `VideoModelId`, `VIDEO_MODEL_CATALOG` from `'../video'`; if that creates a circular import (settings is imported very early), move `isVideoModelEnabled` into `b4m-core/common/src/video/enablement.ts` instead and export it from the video barrel, importing only the `VideoGenerationSettings` type from settings.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @bike4mind/common exec vitest run src/schemas && pnpm --filter @bike4mind/common typecheck`
Expected: PASS. A test that snapshots the full settings registry or setting-key list may need its snapshot updated; update only to include the new key.

- [ ] **Step 5: Commit**

```bash
git add b4m-core/common/src/schemas b4m-core/common/src/video
git commit -m "feat(video): add the job update websocket action and model toggles setting"
```

---

### Task 8: Video job kind (create + handler)

**Files:**
- Create: `b4m-core/services/src/videoJobs/types.ts`, `createVideoJob.ts`, `videoJobHandler.ts`, `index.ts`
- Create: `b4m-core/services/src/videoJobs/createVideoJob.test.ts`, `videoJobHandler.test.ts`
- Modify: `b4m-core/services/package.json` (add `./videoJobs` subpath export)

**Interfaces:**
- Consumes: Task 1 domain; Task 3 `holdCredits`/`settleCreditHold`/`releaseCreditHold`/`CreditHoldAdapters`/`CreditHold`; Task 4 `VideoProviderRegistry`, `ResolvedInputs`, `ProviderPollResult`, `VideoOutputTooLargeError`; Task 5 types and repository; Task 6 `GenerationJobHandler`, `StepResult`; Task 7 `isVideoModelEnabled`, `VideoGenerationSettings`.
- Produces:

```ts
export type VideoJobDeps = {
  repository: IGenerationJobRepository;
  providers: VideoProviderRegistry;
  getSettings(): Promise<{ enforceCredits: boolean; videoGeneration: VideoGenerationSettings | undefined }>;
  resolveApiKey(providerId: VideoProviderId, userId: string): Promise<string | null>;
  loadInputImage(userId: string, fileId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  saveToFiles(params: { userId: string; jobId: string; bytes: Buffer; contentType: string; prompt: string }): Promise<{ saved: true; fileId: string; s3Key: string } | { saved: false; reason: 'storage_limit' | 'file_too_large' | 'error' }>;
  saveToGeneratedBucket(params: { key: string; bytes: Buffer; contentType: string }): Promise<{ s3Key: string }>;
  credits: CreditHoldAdapters;
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  recordUsage(event: { job: IGenerationJobDocument; creditsCharged: number; costUsd: number; durationSeconds: number }): Promise<void>;
  now(): Date;
  logger: Logger;
};
export type CreateVideoJobInput = {
  user: { id: string; organizationId: string | null };
  request: unknown;                       // parsed here, never trusted
  source: GenerationJobSource;
  idempotencyKey?: string;
  questId?: string;
};
export type CreateVideoJobResult =
  | { ok: true; job: IGenerationJobDocument; created: boolean }
  | { ok: false; status: 400 | 402 | 403 | 404 | 422; code: VideoValidationErrorCode | 'invalid_request' | 'model_disabled' | 'model_unavailable' | 'insufficient_credits' | 'input_image_not_found' | 'idempotency_key_reused'; message: string };
export function createVideoJob(input: CreateVideoJobInput, deps: VideoJobDeps): Promise<CreateVideoJobResult>;
export function createVideoJobHandler(deps: VideoJobDeps): GenerationJobHandler;
export const VIDEO_JOB_MAX_WALL_CLOCK_MS = 20 * 60_000;
```

Behaviour of `createVideoJob` (in order; each step's failure is a test below):
1. `VideoGenerationRequestSchema.safeParse(input.request)`; failure -> `400 invalid_request` with the Zod issues flattened into the message.
2. Caps = `getVideoModelCapabilities(model)`; provider registered (`deps.providers.get(caps.provider)`) else `422 model_unavailable`; `isVideoModelEnabled` else `403 model_disabled`.
3. `validateAgainstCapabilities`; failure -> `422 <code>`.
4. If `image_to_video`: `loadInputImage(user.id, fileId)` must return non-null else `404 input_image_not_found` (fast failure; the handler loads it again at submit).
5. If `idempotencyKey`: `repository.findByIdempotencyKey`; found with the same request (deep-equal) -> `{ ok: true, job, created: false }`; found with a different request -> `422 idempotency_key_reused`.
6. `estimateVideoCostCredits`; if `enforceCredits`: `holdCredits({ userId, organizationId, requiredCredits, featureLabel: 'video generation' })`; an `insufficientCreditsError` -> `402 insufficient_credits` with its message.
7. `repository.createJob({ state: 'pending', nextPollAt: now, deadlineAt: now + VIDEO_JOB_MAX_WALL_CLOCK_MS, creditHold: hold ?? null, ... })`. A duplicate-key error (`code === 11000`) on the idempotency index -> release the hold, re-read by key and return it with `created: false`. Any other error -> release the hold and rethrow.
8. `enqueue(job.id, 0)`; if it throws -> commit `{ state: 'failed', error: { code: 'enqueue_failed', ... } }`, release the hold, mark terminal handled (`claimTerminalHandling` + `markTerminalHandled`), and rethrow so the caller returns 5xx.

Behaviour of the handler:
- `submit`: resolve the API key (`null` -> `failed provider_error 'No API key configured for <provider>'`); for image_to_video load the input image (`null` -> `failed input_image_not_found`); re-validate (defensive, cheap) and call `provider.submit`; return `{ next: 'running', payload: { ...payload, providerHandle } }`. `ProviderSubmitError` propagates (the engine classifies it).
- `poll`: `provider.poll(handle)`; map `running -> poll_again`, `succeeded -> storing` (persist `providerOutput`, `reportedDurationSeconds`; an inline output larger than `MAX_INLINE_PROVIDER_OUTPUT_BYTES` in base64-decoded size -> `failed output_too_large`), `blocked -> blocked content_blocked`, `failed retryable -> retry`, `failed non-retryable -> failed provider_error`.
- `store`: `provider.fetchOutput` (a `VideoOutputTooLargeError` -> `failed output_too_large`); `saveToFiles` first; on `saved: false` -> `saveToGeneratedBucket({ key: 'generated-video/<ownerId>/<jobId>.mp4' })`; before `saveToFiles`, if the payload already has `output` (a re-run after a crash between save and commit), return `succeeded` with it unchanged. Also clear `providerOutput` from the payload (it may hold base64) when returning `succeeded`.
- `cancelAtProvider`: `provider.cancel?.(handle)` when a handle exists.
- `onTerminal`: if `creditHold` is null, only record usage for `succeeded`. If `succeeded`: charged credits = `estimateVideoCostCredits(caps, { ...request, durationSeconds: reportedDurationSeconds ?? request.durationSeconds })`; `settleCreditHold(hold, charged, { type: 'video_generation_usage', sessionId: job.questId ?? job.id, questId: job.questId, model: request.model }, ...)`; `recordUsage`. Otherwise `releaseCreditHold`.

- [ ] **Step 1: Write the failing `createVideoJob` tests**

Use the in-memory repository from Task 6 (import it by relative path `../generationJobs/__test__/inMemoryGenerationJobRepository`), `createVideoProviderRegistry([new TestVideoProvider()])`, and `vi.fn` deps:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';
import { createVideoProviderRegistry, TestVideoProvider } from '@bike4mind/utils/videoProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { createVideoJob } from './createVideoJob';
import type { VideoJobDeps } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(async (p: { userId: string; requiredCredits: number }) => ({
    ownerId: p.userId, ownerType: 'User', userId: p.userId, organizationId: null, reservedCredits: p.requiredCredits,
  })),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_h: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold } from '../creditService/creditHold';

const validRequest = { model: 'test-video', mode: 'text_to_video', prompt: 'a cat', durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' };

const makeDeps = (overrides: Partial<VideoJobDeps> = {}): VideoJobDeps & { repository: ReturnType<typeof createInMemoryGenerationJobRepository> } => ({
  repository: createInMemoryGenerationJobRepository(),
  providers: createVideoProviderRegistry([new TestVideoProvider()]),
  getSettings: async () => ({ enforceCredits: true, videoGeneration: undefined }),
  resolveApiKey: async () => 'key',
  loadInputImage: async () => ({ bytes: Buffer.from('img'), mimeType: 'image/png' }),
  saveToFiles: vi.fn(),
  saveToGeneratedBucket: vi.fn(),
  credits: {} as VideoJobDeps['credits'],
  enqueue: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => undefined),
  now: () => new Date('2026-10-06T00:00:00Z'),
  logger: new Logger({ metadata: { test: 'createVideoJob' } }),
  ...overrides,
}) as never;

const user = { id: 'u1', organizationId: null };

describe('createVideoJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('holds credits, creates a pending job and enqueues it immediately', async () => {
    const deps = makeDeps();
    const result = await createVideoJob({ user, request: validRequest, source: 'studio' }, deps);
    expect(result).toMatchObject({ ok: true, created: true, job: { state: 'pending', creditHold: { reservedCredits: expect.any(Number) } } });
    expect(deps.enqueue).toHaveBeenCalledWith(expect.any(String), 0);
  });

  it('invalid request holds no credits', async () => {
    const deps = makeDeps();
    const result = await createVideoJob({ user, request: { ...validRequest, durationSeconds: 12 }, source: 'api' }, deps);
    expect(result).toMatchObject({ ok: false, status: 422, code: 'unsupported_duration' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('rejects malformed input with invalid_request', async () => {
    const result = await createVideoJob({ user, request: { model: 'nope' }, source: 'api' }, makeDeps());
    expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_request' });
  });

  it('rejects a disabled model', async () => {
    const deps = makeDeps({ getSettings: async () => ({ enforceCredits: true, videoGeneration: { enabledModels: { 'test-video': false } } }) });
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({ ok: false, status: 403, code: 'model_disabled' });
  });

  it('rejects a model whose provider is not registered', async () => {
    const deps = makeDeps({ providers: createVideoProviderRegistry([]) });
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({ ok: false, status: 422, code: 'model_unavailable' });
  });

  it('rejects image_to_video when the input image is not the user\'s', async () => {
    const deps = makeDeps({ loadInputImage: async () => null });
    const result = await createVideoJob({ user, request: { ...validRequest, mode: 'image_to_video', inputImageFileId: 'f9' }, source: 'api' }, deps);
    expect(result).toMatchObject({ ok: false, status: 404, code: 'input_image_not_found' });
  });

  it('maps insufficient credits to 402', async () => {
    vi.mocked(holdCredits).mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, makeDeps())).toMatchObject({ ok: false, status: 402, code: 'insufficient_credits' });
  });

  it('skips the hold when credits are not enforced', async () => {
    const deps = makeDeps({ getSettings: async () => ({ enforceCredits: false, videoGeneration: undefined }) });
    const result = await createVideoJob({ user, request: validRequest, source: 'api' }, deps);
    expect(result).toMatchObject({ ok: true, job: { creditHold: null } });
  });

  it('returns the existing job for a repeated idempotency key with the same request', async () => {
    const deps = makeDeps();
    const first = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) expect(second.job.id).toBe(first.job.id);
  });

  it('rejects a reused idempotency key with a different request', async () => {
    const deps = makeDeps();
    await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createVideoJob({ user, request: { ...validRequest, prompt: 'a dog' }, source: 'api', idempotencyKey: 'k1' }, deps);
    expect(second).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
  });

  it('releases the hold and fails the job when enqueue throws', async () => {
    const deps = makeDeps({ enqueue: vi.fn(async () => { throw new Error('SQS down'); }) });
    await expect(createVideoJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('SQS down');
    const [job] = [...deps.repository.jobs.values()];
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('enqueue_failed');
    expect(job.terminalHandledAt).toBeTruthy();
    expect(releaseCreditHold).toHaveBeenCalled();
  });
});
```

Add `beforeEach(() => vi.clearAllMocks())` at the top of the describe so `holdCredits`/`releaseCreditHold` call assertions are per-test (and per the memory note on hoisted mock implementations leaking across describes, re-set any `mockImplementation` in `beforeEach` rather than relying on the factory after a `mockRejectedValueOnce`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bike4mind/services exec vitest run src/videoJobs/createVideoJob.test.ts`
Expected: FAIL - `Cannot find module './createVideoJob'`.

- [ ] **Step 3: Implement `types.ts` and `createVideoJob.ts`**

`types.ts` holds `VideoJobDeps`, `CreateVideoJobInput`, `CreateVideoJobResult` and `VIDEO_JOB_MAX_WALL_CLOCK_MS` exactly as in the Interfaces block.

```ts
// createVideoJob.ts
import { isDeepStrictEqual } from 'node:util';
import {
  CreditHolderType,
  estimateVideoCostCredits,
  getVideoModelCapabilities,
  isVideoModelEnabled,
  validateAgainstCapabilities,
  VideoGenerationRequestSchema,
  type IGenerationJobDocument,
} from '@bike4mind/common';
import { holdCredits, releaseCreditHold, type CreditHold } from '../creditService/creditHold';
import { VIDEO_JOB_MAX_WALL_CLOCK_MS, type CreateVideoJobInput, type CreateVideoJobResult, type VideoJobDeps } from './types';

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

// insufficientCreditsError produces an error the API layer maps to 402; detect it structurally.
const isInsufficientCredits = (error: unknown): error is Error =>
  error instanceof Error && /enough credits|credit limit/i.test(error.message);

export async function createVideoJob(input: CreateVideoJobInput, deps: VideoJobDeps): Promise<CreateVideoJobResult> {
  const parsed = VideoGenerationRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    return { ok: false, status: 400, code: 'invalid_request', message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const request = parsed.data;
  const caps = getVideoModelCapabilities(request.model);
  if (!deps.providers.get(caps.provider)) {
    return { ok: false, status: 422, code: 'model_unavailable', message: `${caps.displayName} is not available in this environment` };
  }
  const settings = await deps.getSettings();
  if (!isVideoModelEnabled(request.model, settings.videoGeneration)) {
    return { ok: false, status: 403, code: 'model_disabled', message: `${caps.displayName} is disabled by your administrator` };
  }
  const validation = validateAgainstCapabilities(request, caps);
  if (!validation.ok) return { ok: false, status: 422, code: validation.code, message: validation.message };

  if (request.mode === 'image_to_video' && request.inputImageFileId) {
    const image = await deps.loadInputImage(input.user.id, request.inputImageFileId);
    if (!image) return { ok: false, status: 404, code: 'input_image_not_found', message: 'Input image not found' };
  }

  const ownerType = input.user.organizationId ? CreditHolderType.Organization : CreditHolderType.User;
  const ownerId = input.user.organizationId ?? input.user.id;
  if (input.idempotencyKey) {
    const existing = await deps.repository.findByIdempotencyKey(ownerType, ownerId, input.idempotencyKey);
    if (existing) return replayOrReject(existing, request);
  }

  let hold: CreditHold | null = null;
  if (settings.enforceCredits) {
    try {
      hold = await holdCredits(
        { userId: input.user.id, organizationId: input.user.organizationId, requiredCredits: estimateVideoCostCredits(caps, request), featureLabel: 'video generation' },
        deps.credits
      );
    } catch (error) {
      if (isInsufficientCredits(error)) return { ok: false, status: 402, code: 'insufficient_credits', message: error.message };
      throw error;
    }
  }

  const now = deps.now();
  let job: IGenerationJobDocument;
  try {
    job = await deps.repository.createJob({
      kind: 'video',
      ownerType,
      ownerId,
      requestedBy: input.user.id,
      source: input.source,
      state: 'pending',
      payload: { request, providerId: caps.provider },
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      // Set at creation so the sweeper also recovers a job whose first message was lost.
      nextPollAt: now,
      deadlineAt: new Date(now.getTime() + VIDEO_JOB_MAX_WALL_CLOCK_MS),
      idempotencyKey: input.idempotencyKey,
      creditHold: hold,
      questId: input.questId,
    });
  } catch (error) {
    if (hold) await releaseCreditHold(hold, deps.credits);
    if (input.idempotencyKey && isDuplicateKeyError(error)) {
      const winner = await deps.repository.findByIdempotencyKey(ownerType, ownerId, input.idempotencyKey);
      if (winner) return replayOrReject(winner, request);
    }
    throw error;
  }

  try {
    await deps.enqueue(job.id, 0);
  } catch (error) {
    await failUnqueuedJob(job, hold, deps);
    throw error;
  }
  return { ok: true, job, created: true };
}

const replayOrReject = (existing: IGenerationJobDocument, request: unknown): CreateVideoJobResult =>
  isDeepStrictEqual(existing.payload.request, request)
    ? { ok: true, job: existing, created: false }
    : { ok: false, status: 422, code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used with a different request' };

// The job never reached the queue, so nothing else will ever settle it: fail it and return the credits here.
async function failUnqueuedJob(job: IGenerationJobDocument, hold: CreditHold | null, deps: VideoJobDeps) {
  await deps.repository.commit(job.id, { state: 'failed', nextPollAt: null, error: { code: 'enqueue_failed', message: 'The job could not be queued' } });
  if (await deps.repository.claimTerminalHandling(job.id, deps.now())) {
    if (hold) await releaseCreditHold(hold, deps.credits);
    await deps.repository.markTerminalHandled(job.id, deps.now());
  }
}
```

Before implementing `isInsufficientCredits`, open `b4m-core/common/src/insufficientCredits.ts`: if `insufficientCreditsError` creates a class instance or sets a code property, detect that (e.g. `error instanceof InsufficientCreditsError` or `error.code === 'insufficient_credits'`) instead of matching the message.

- [ ] **Step 4: Run createVideoJob tests**

Run: `pnpm --filter @bike4mind/services exec vitest run src/videoJobs/createVideoJob.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Write the failing handler tests**

`videoJobHandler.test.ts` runs the real engine (Task 6) with the real `TestVideoProvider`, the in-memory repo, and fake storage deps, driving the job to completion:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoProviderRegistry, TestVideoProvider } from '@bike4mind/utils/videoProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import { createVideoJob } from './createVideoJob';
import { createVideoJobHandler } from './videoJobHandler';
import type { VideoJobDeps } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_h: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold, settleCreditHold } from '../creditService/creditHold';

const setup = (overrides: Partial<VideoJobDeps> = {}) => {
  let clock = new Date('2026-10-06T00:00:00Z');
  const repository = createInMemoryGenerationJobRepository();
  const queue: string[] = [];
  const deps: VideoJobDeps = {
    repository,
    providers: createVideoProviderRegistry([new TestVideoProvider()]),
    getSettings: async () => ({ enforceCredits: true, videoGeneration: undefined }),
    resolveApiKey: async () => 'key',
    loadInputImage: async () => ({ bytes: Buffer.from('img'), mimeType: 'image/png' }),
    saveToFiles: vi.fn(async ({ jobId }) => ({ saved: true as const, fileId: `file-${jobId}`, s3Key: `files/${jobId}.mp4` })),
    saveToGeneratedBucket: vi.fn(async ({ key }) => ({ s3Key: key })),
    credits: {} as VideoJobDeps['credits'],
    enqueue: vi.fn(async (jobId: string) => { queue.push(jobId); }),
    recordUsage: vi.fn(async () => undefined),
    now: () => clock,
    logger: new Logger({ metadata: { test: 'videoJobHandler' } }),
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository, handlers: [createVideoJobHandler(deps)], enqueue: deps.enqueue, notify: async () => undefined,
    now: () => clock, logger: deps.logger, leaseMs: 330_000,
  });
  // Drain the queue, advancing the clock past each delay, until the job is terminal.
  const runToCompletion = async () => {
    for (let i = 0; i < 20 && queue.length; i++) {
      const jobId = queue.shift()!;
      clock = new Date(clock.getTime() + 60_000);
      await engine.step(jobId);
    }
  };
  return { deps, repository, runToCompletion };
};
const request = (prompt = 'a cat') => ({ model: 'test-video', mode: 'text_to_video', prompt, durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' });
const user = { id: 'u1', organizationId: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(holdCredits).mockImplementation(async p => ({ ownerId: p.userId, ownerType: 'User' as never, userId: p.userId, organizationId: null, reservedCredits: p.requiredCredits }));
});

describe('video job end to end with the test provider', () => {
  it('stores the clip in Files, settles credits once and records usage', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.repository.jobs.get(created.ok ? created.job.id : '')!;
    expect(job.state).toBe('succeeded');
    expect(job.payload.output).toMatchObject({ location: 'files', fileId: expect.any(String), contentType: 'video/mp4' });
    expect(job.payload.providerOutput).toBeUndefined();
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    expect(t.deps.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generated bucket when Files refuses', async () => {
    const t = setup({ saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })) });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.repository.jobs.get(created.ok ? created.job.id : '')!;
    expect(job.state).toBe('succeeded');
    expect(job.payload.output).toMatchObject({ location: 'generated', s3Key: `generated-video/u1/${job.id}.mp4` });
    expect(job.payload.output?.fileId).toBeUndefined();
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
  });

  it('a policy block releases the hold and charges nothing', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request('a cat [blocked]'), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.repository.jobs.get(created.ok ? created.job.id : '')!;
    expect(job).toMatchObject({ state: 'blocked', error: { code: 'content_blocked' } });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });

  it('a provider failure releases the hold', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request('a cat [fail]'), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.repository.jobs.get(created.ok ? created.job.id : '')!.error?.code).toBe('provider_error');
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('fails cleanly when no API key resolves for the provider', async () => {
    const t = setup({ resolveApiKey: async () => null });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.repository.jobs.get(created.ok ? created.job.id : '')!).toMatchObject({ state: 'failed', error: { code: 'provider_error' } });
  });

  it('a store re-run after a crash between save and commit does not save twice', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.repository.jobs.get(created.ok ? created.job.id : '')!;
    // Simulate: output persisted but the terminal commit never happened.
    Object.assign(job, { state: 'storing', terminalHandledAt: null, terminalHandlingClaimedAt: null, leaseUntil: null });
    const handler = createVideoJobHandler(t.deps);
    const result = await handler.store(structuredClone(job));
    expect(result).toMatchObject({ next: 'succeeded' });
    expect(t.deps.saveToFiles).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @bike4mind/services exec vitest run src/videoJobs/videoJobHandler.test.ts`
Expected: FAIL - `Cannot find module './videoJobHandler'`.

- [ ] **Step 7: Implement `videoJobHandler.ts`**

```ts
import {
  estimateVideoCostCredits,
  estimateVideoCostUsd,
  getVideoModelCapabilities,
  MAX_INLINE_PROVIDER_OUTPUT_BYTES,
  validateAgainstCapabilities,
  type IGenerationJobDocument,
  type VideoJobPayload,
} from '@bike4mind/common';
import { VideoOutputTooLargeError, type ProviderJobHandle, type ProviderOutput, type VideoProviderContext } from '@bike4mind/utils/videoProviders';
import { releaseCreditHold, settleCreditHold } from '../creditService/creditHold';
import type { GenerationJobHandler, StepResult } from '../generationJobs/types';
import { VIDEO_JOB_MAX_WALL_CLOCK_MS, type VideoJobDeps } from './types';

const fail = (code: 'provider_error' | 'input_image_not_found' | 'output_too_large', message: string, raw?: unknown): StepResult => ({
  next: 'failed',
  error: { code, message },
  rawProviderError: raw,
});

const inlineBytes = (output: ProviderOutput) => (output.kind === 'inline' ? Math.floor((output.base64.length * 3) / 4) : 0);

export function createVideoJobHandler(deps: VideoJobDeps): GenerationJobHandler {
  const providerFor = (job: IGenerationJobDocument) => {
    const provider = deps.providers.get(job.payload.providerId);
    if (!provider) throw new Error(`video provider '${job.payload.providerId}' is not registered`);
    return provider;
  };
  const contextFor = async (job: IGenerationJobDocument): Promise<VideoProviderContext | null> => {
    const apiKey = await deps.resolveApiKey(job.payload.providerId, job.requestedBy);
    // 'expired' is how getEffectiveLLMApiKeys reports an expired user key; treat it as absent.
    if (!apiKey || apiKey === 'expired') return null;
    return { apiKey, logger: deps.logger, now: deps.now };
  };
  const handleOf = (payload: VideoJobPayload) => payload.providerHandle as ProviderJobHandle;

  return {
    kind: 'video',
    maxWallClockMs: VIDEO_JOB_MAX_WALL_CLOCK_MS,

    async submit(job) {
      const ctx = await contextFor(job);
      if (!ctx) return fail('provider_error', `No API key configured for ${job.payload.providerId}`);
      const { request } = job.payload;
      const validation = validateAgainstCapabilities(request, getVideoModelCapabilities(request.model));
      if (!validation.ok) return fail('provider_error', `stored request no longer valid: ${validation.message}`);
      let inputs = {};
      if (request.mode === 'image_to_video' && request.inputImageFileId) {
        const image = await deps.loadInputImage(job.requestedBy, request.inputImageFileId);
        if (!image) return fail('input_image_not_found', 'Input image not found');
        inputs = { inputImage: image };
      }
      const providerHandle = await providerFor(job).submit(validation.request, inputs, ctx);
      return { next: 'running', payload: { ...job.payload, providerHandle } };
    },

    async poll(job) {
      const ctx = await contextFor(job);
      if (!ctx) return fail('provider_error', `No API key configured for ${job.payload.providerId}`);
      const result = await providerFor(job).poll(handleOf(job.payload), ctx);
      switch (result.status) {
        case 'running':
          return { next: 'poll_again', progress: result.progress };
        case 'succeeded':
          if (inlineBytes(result.output) > MAX_INLINE_PROVIDER_OUTPUT_BYTES) {
            return fail('output_too_large', 'Inline provider output exceeds the persistable limit; the adapter must use URL delivery');
          }
          return {
            next: 'storing',
            payload: { ...job.payload, providerOutput: result.output, reportedDurationSeconds: result.reportedDurationSeconds },
          };
        case 'blocked':
          return { next: 'blocked', error: { code: 'content_blocked', message: 'The provider declined this request under its content policy' }, rawProviderError: result.raw };
        case 'failed':
          return result.retryable ? { next: 'retry', reason: result.message } : fail('provider_error', result.message, result.raw);
      }
    },

    async store(job) {
      const { payload } = job;
      // A re-run after a crash between saving and committing: the save already happened.
      if (payload.output) return { next: 'succeeded', payload: { ...payload, providerOutput: undefined } };
      const ctx = await contextFor(job);
      if (!ctx) return fail('provider_error', `No API key configured for ${payload.providerId}`);
      if (!payload.providerOutput) return fail('provider_error', 'storing without provider output');

      let bytes: Buffer;
      try {
        bytes = await providerFor(job).fetchOutput(payload.providerOutput, ctx);
      } catch (error) {
        if (error instanceof VideoOutputTooLargeError) return fail('output_too_large', error.message);
        throw error;
      }
      const contentType = payload.providerOutput.contentType ?? 'video/mp4';
      const durationSeconds = payload.reportedDurationSeconds ?? payload.request.durationSeconds;

      const files = await deps.saveToFiles({ userId: job.requestedBy, jobId: job.id, bytes, contentType, prompt: payload.request.prompt });
      const output = files.saved
        ? { location: 'files' as const, s3Key: files.s3Key, fileId: files.fileId, contentType, bytes: bytes.byteLength, durationSeconds }
        : {
            location: 'generated' as const,
            ...(await deps.saveToGeneratedBucket({ key: `generated-video/${job.ownerId}/${job.id}.mp4`, bytes, contentType })),
            contentType,
            bytes: bytes.byteLength,
            durationSeconds,
          };
      if (!files.saved) deps.logger.warn('video saved outside Files', { jobId: job.id, reason: files.reason });
      return { next: 'succeeded', payload: { ...payload, providerOutput: undefined, output } };
    },

    async cancelAtProvider(job) {
      const handle = job.payload.providerHandle;
      const provider = deps.providers.get(job.payload.providerId);
      const ctx = await contextFor(job);
      if (handle && provider?.cancel && ctx) await provider.cancel(handle as ProviderJobHandle, ctx);
    },

    async onTerminal(job) {
      const { request } = job.payload;
      const caps = getVideoModelCapabilities(request.model);
      if (job.state !== 'succeeded') {
        if (job.creditHold) await releaseCreditHold(job.creditHold, deps.credits);
        return;
      }
      const billed = { ...request, durationSeconds: job.payload.reportedDurationSeconds ?? request.durationSeconds };
      const charged = job.creditHold
        ? await settleCreditHold(
            job.creditHold,
            estimateVideoCostCredits(caps, billed),
            { type: 'video_generation_usage', sessionId: job.questId ?? job.id, questId: job.questId ?? job.id, model: request.model } as never,
            { featureLabel: 'video generation', logger: deps.logger },
            deps.credits
          )
        : 0;
      await deps.recordUsage({ job, creditsCharged: charged, costUsd: estimateVideoCostUsd(caps, billed), durationSeconds: billed.durationSeconds });
    },
  };
}
```

Replace the `as never` on the ledger entry with the precise `CreditLedgerEntry` variant for `'video_generation_usage'`: read the `type` union in `deductCreditsWithOrgSupport.ts:~20-37` and supply exactly its required fields. `sessionId` and `questId` are required by the existing quest-scoped variant; jobs without a quest use the job id, and plan 2 revisits whether a non-quest ledger variant is warranted.

`index.ts`:

```ts
export * from './types';
export * from './createVideoJob';
export * from './videoJobHandler';
```

- [ ] **Step 8: Run all video job tests and typecheck**

Run: `pnpm --filter @bike4mind/services exec vitest run src/videoJobs src/generationJobs && pnpm --filter @bike4mind/services typecheck`
Expected: PASS; clean.

- [ ] **Step 9: Commit**

```bash
git add b4m-core/services/src/videoJobs b4m-core/services/package.json
git commit -m "feat(video): add the video job kind on the generation-job engine"
```

---

### Task 9: Production wiring, queue handler and infrastructure

**Files:**
- Create: `apps/client/server/generationJobs/wiring.ts`, `apps/client/server/generationJobs/wiring.test.ts`
- Create: `apps/client/server/queueHandlers/generationJob.ts`, `apps/client/server/queueHandlers/generationJob.test.ts`
- Modify: `infra/queues.ts`, `infra/web.ts`, `infra/dlqAlarms.ts`, `infra/logMonitor.ts`, `apps/client/server/utils/dlqRegistry.ts`, `apps/client/server/utils/dlqRegistry.test.ts:51`
- Modify (self-host, pinned by `b4m-core/resource/src/selfHostQueueParity.test.ts`): `elasticmq.conf`, `.env.selfhost.example`, `b4m-core/resource/src/manifest.ts`, `apps/workers/src/selfhost/main.ts`

**Interfaces:**
- Consumes: everything above; `sendToQueue(queueUrl, message, delaySeconds?)` from `apps/client/server/utils/sqs.ts:94`; `getSourceQueueUrl` from `dlqRegistry.ts:285`; `ClientMessageSender` from `@bike4mind/utils`; `getEffectiveLLMApiKeys` from `@bike4mind/auth`; `fabFilesService.createFabFile` pattern from `apps/client/server/utils/persistGeneratedAudio.ts:45`; `getFilesStorage()`, `getGeneratedImageStorage()` from `apps/client/server/utils/storage/index.ts`; repositories from `@bike4mind/database`; `getSettingsMap`/`getSettingsValue` from `@bike4mind/utils`.
- Produces: `getGenerationJobEngine(): GenerationJobEngine`, `getVideoJobDeps(): VideoJobDeps` (lazy singletons), `enqueueGenerationJob(jobId: string, delaySeconds: number): Promise<void>`, and `dispatch` (SQS handler).

- [ ] **Step 1: Write the failing handler test**

```ts
// generationJob.test.ts
import { describe, expect, it, vi } from 'vitest';

const step = vi.fn(async () => 'advanced');
vi.mock('@server/generationJobs/wiring', () => ({ getGenerationJobEngine: () => ({ step }) }));
import { dispatch } from './generationJob';

const event = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const context = { awsRequestId: 'r1' } as never;

describe('generationJob dispatch', () => {
  it('runs exactly one engine step for the message job id', async () => {
    await dispatch(event({ jobId: 'job1' }), context, () => undefined);
    expect(step).toHaveBeenCalledWith('job1');
  });

  it('drops a malformed message instead of retrying it forever', async () => {
    step.mockClear();
    await expect(dispatch(event({ nope: true }), context, () => undefined)).resolves.toBeUndefined();
    expect(step).not.toHaveBeenCalled();
  });
});
```

Check `dispatchWithLogger`'s signature in `apps/client/server/queueHandlers/utils.ts` and adapt the call shape in the test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bike4mind/client exec vitest run server/queueHandlers/generationJob.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement the handler**

```ts
// apps/client/server/queueHandlers/generationJob.ts
import { z } from 'zod';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { getGenerationJobEngine } from '@server/generationJobs/wiring';

const GenerationJobMessageSchema = z.object({ jobId: z.string().min(1) });

// One engine step per message. A thrown error lets SQS redeliver; the engine's lease makes that safe.
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const parsed = GenerationJobMessageSchema.safeParse(JSON.parse(event.Records[0].body));
  if (!parsed.success) {
    logger.error('generation job message malformed; dropping', { requestId: context.awsRequestId, issues: parsed.error.issues });
    return;
  }
  const outcome = await getGenerationJobEngine().step(parsed.data.jobId);
  logger.debug('generation job step', { jobId: parsed.data.jobId, outcome });
});
```

- [ ] **Step 4: Implement `wiring.ts`**

Build lazily, mirroring `getVideoGeneration()` in `apps/client/server/queueHandlers/videoGeneration.ts:24-77`:

```ts
import { Resource } from 'sst';
import { getEffectiveLLMApiKeys } from '@bike4mind/auth';
import { KnowledgeType, type IGenerationJobDocument, type VideoProviderId } from '@bike4mind/common';
import {
  adminSettingsRepository, apiKeyRepository, Connection, creditTransactionRepository, generationJobRepository,
  organizationRepository, usageEventRepository, userRepository,
} from '@bike4mind/database';
import { GenerationJobEngine } from '@bike4mind/services/generationJobs';
import { createVideoJobHandler, type VideoJobDeps } from '@bike4mind/services/videoJobs';
import { ClientMessageSender, getSettingsByNames, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { createVideoProviderRegistry, TestVideoProvider, type VideoProvider } from '@bike4mind/utils/videoProviders';
import { Logger } from '@bike4mind/observability';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendToQueue } from '@server/utils/sqs';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';

// Lease must outlive the 5-minute worker timeout (infra/queues.ts generationJobQueue) so two workers never overlap.
const LEASE_MS = 5 * 60_000 + 30_000;

const buildProviders = (): VideoProvider[] => {
  const providers: VideoProvider[] = [];
  // Set only on non-production stages by infra; never registered in production.
  if (process.env.ENABLE_TEST_VIDEO_PROVIDER === 'true') providers.push(new TestVideoProvider());
  return providers;
};

export const enqueueGenerationJob = async (jobId: string, delaySeconds: number): Promise<void> => {
  if (process.env.BYPASS_QUEUE === 'true') {
    // Local dev without SQS: run the step in-process after the delay.
    setTimeout(() => void getGenerationJobEngine().step(jobId).catch(error => Logger.globalInstance.error('inline generation job step failed', { jobId, error })), delaySeconds * 1000);
    return;
  }
  await sendToQueue(getSourceQueueUrl('generationJobQueue'), { jobId }, delaySeconds);
};
```

Then implement, each as a small named function in this file:
- `resolveApiKey(providerId, userId)`: `getEffectiveLLMApiKeys(userId, { db: { adminSettings: adminSettingsRepository, apiKeys: apiKeyRepository }, getSettingsByNames })` (copy the exact adapter object from `VideoGeneration.ts`'s call) and map `VideoProviderId` -> key field with an exhaustive `switch` over `VideoProviderId` (`'test'` -> `'test-key'`); each provider PR adds its case and the compiler forces it.
- `loadInputImage(userId, fileId)`: load the FabFile via the FabFile repository, return `null` unless the file exists, belongs to the user (check `defineAbilitiesFor(user).can('read', fabFile)` the way existing file routes do; find one with `grep -rn "can('read'" apps/client/pages/api/files | head`) and `mimeType` starts with `image/`; then `getFilesStorage().download(fabFile.filePath)` (check the field name on the FabFile entity).
- `saveToFiles(...)`: copy `persistGeneratedAudio.ts`'s `createFabFile` call with `type: KnowledgeType.VIDEO`, `prefix: 'generated-video'`, `fileName: \`video-${jobId}.mp4\``, tags `[{ name: 'generated' }, { name: 'video' }, { name: \`job:${jobId}\` }]`; map the storage-limit / max-file-size `BadRequestError`s to `{ saved: false, reason }` exactly as `persistGeneratedAudio` does; return `s3Key` = the created FabFile's storage path. Before creating, look up an existing FabFile with tag `job:${jobId}` for the user and return it if found (idempotent re-run).
- `saveToGeneratedBucket({ key, bytes, contentType })`: `getGeneratedImageStorage().upload(bytes, key, { ContentType: contentType })` -> `{ s3Key: key }`.
- `getSettings()`: `const settings = await getSettingsMap({ adminSettings: adminSettingsRepository } as never); return { enforceCredits: getSettingsValue('enforceCredits', settings), videoGeneration: getSettingsValue('videoGeneration', settings) };` (copy the exact `getSettingsMap` argument from `VideoGeneration.ts:359`).
- `recordUsage(...)`: `usageEventRepository.record({...})` with the field set from `VideoGeneration.ts:579-599` (`feature: 'video_generation'`, `provider: job.payload.providerId`, `units: durationSeconds`, `status: 'ok'`, `latencyMs: now - createdAt`), catching and logging failures.
- `notify(job)`: `new ClientMessageSender({ connections: Connection } as never, logger).sendToClient(job.requestedBy, Resource.websocket.managementEndpoint, { action: 'generation_job_updated', job: toJobUpdate(job) })`, where `toJobUpdate` maps to the Task 7 schema (never includes `rawProviderError` or `creditHold`).
- `credits`: `{ users: userRepository, organizations: organizationRepository, creditTransactions: creditTransactionRepository }`.

`getVideoJobDeps()` and `getGenerationJobEngine()` are lazy module-level singletons composing the above with `repository: generationJobRepository`, `now: () => new Date()`, `leaseMs: LEASE_MS`.

- [ ] **Step 5: Test the wiring's pure mappers**

`wiring.test.ts` covers the two functions most likely to be wrong and cheapest to test: `toJobUpdate` (strips internal fields; includes `output.fileId` only when present) and the provider-to-key `switch` (unknown provider is a compile error, so test `'test'` returns a key). Export both for testing. Mock `sst` and `@bike4mind/database` at the top as other `server/` tests do.

Run: `pnpm --filter @bike4mind/client exec vitest run server/generationJobs server/queueHandlers/generationJob.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the queue to infra**

In `infra/queues.ts`, next to the video queue (~L1097), add:

```ts
const generationJobDLQ = new sst.aws.Queue('generationJobDLQ', {});
const generationJobQueue = new sst.aws.Queue('generationJobQueue', {
  visibilityTimeout: '6 minutes', // worker timeout (5 min) + margin; must exceed it so a running step is not redelivered
  dlq: { queue: generationJobDLQ.arn, retry: 5 },
});
const generationJobQueueSubscription = generationJobQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/generationJob.dispatch',
    runtime: 'nodejs24.x',
    timeout: '5 minutes',
    memory: '2048 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, generatedImagesBucket, fabFileBucket, generationJobQueue],
    logging: { retention: '3 days' },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
      ...($app.stage === 'production' ? {} : { ENABLE_TEST_VIDEO_PROVIDER: 'true' }),
    },
  },
  SINGLE_RECORD_BATCH
);
```

Copy the exact `link` list from the video subscription and add `generationJobQueue` (the handler re-enqueues to itself). Add the three `export { ... }` entries (queue, DLQ, subscription) alongside the video ones (~L1656, ~L1729).

- `infra/web.ts`: import the queue and DLQ; add `'generation-job': generationJobDLQ.url,` to the `dlqUrls` Linkable (~L125) and `generationJobQueue: generationJobQueue.url,` to `sourceQueueUrls` (~L187); add `ENABLE_TEST_VIDEO_PROVIDER` to the web function environment on non-production stages the same way (find where `DEFAULT_LAMBDA_ENVIRONMENT` is spread for the Next.js server).
- `infra/dlqAlarms.ts`: add `{ label: 'generation-job', displayName: 'Generation Job', application: 'GenerationJob', sourceQueue: 'generationJobQueue', queue: generationJobDLQ }` to `DLQ_DESCRIPTORS` (~L221 pattern), and to the second list near L362-375 if it mirrors the registry (read the whole file first).
- `infra/logMonitor.ts`: import `generationJobQueueSubscription` and add its log group to `individualLogGroups` (~L168 pattern).
- `apps/client/server/utils/dlqRegistry.ts`: add `{ label: 'generation-job', displayName: 'Generation Job', application: 'GenerationJob', sourceQueue: 'generationJobQueue' }` to `DLQ_REGISTRY` (~L115).
- `apps/client/server/utils/dlqRegistry.test.ts:51`: add `generationJobQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/generationJobQueue',` to the fixture.

- [ ] **Step 7: Add the queue to self-host**

- `elasticmq.conf` (alphabetical, ~L69): `  generationJobQueue { defaultVisibilityTimeout = 360 seconds }` and its DLQ if the file lists DLQs (follow `githubLakeIngestQueue`).
- `.env.selfhost.example` (~L167): `GENERATION_JOB_QUEUE=http://sqs:9324/000000000000/generationJobQueue`
- `b4m-core/resource/src/manifest.ts` (`DEFAULT_MANIFEST`, ~L118): `generationJobQueue: { kind: 'queue' },` (required, not optional: video jobs cannot run without it).
- `apps/workers/src/selfhost/main.ts`: import `dispatch as generationJobDispatch` from `@server/queueHandlers/generationJob` and register it like the generation-callback block (~L153-161) with `visibilityTimeoutSec: 360`, `maxReceiveCount: 5`. Because the manifest entry is required, register unconditionally using `Resource.generationJobQueue.url`.
- If `b4m-core/resource/src/manifestCoverage.test.ts` or `index.test.ts` enumerate queues, add the new one where `githubLakeIngestQueue` appears.

Run: `pnpm --filter @bike4mind/resource test && pnpm --filter @bike4mind/workers test && pnpm --filter @bike4mind/client exec vitest run server/utils/dlqRegistry.test.ts`
Expected: PASS, including `selfHostQueueParity.test.ts`.

- [ ] **Step 8: Typecheck infra and commit**

Run: `pnpm turbo:typecheck` (dispatch to a verify agent; the client typecheck needs the larger heap per repo convention).
Expected: clean.

```bash
git add apps/client/server/generationJobs apps/client/server/queueHandlers/generationJob.ts apps/client/server/queueHandlers/generationJob.test.ts infra apps/client/server/utils/dlqRegistry.ts apps/client/server/utils/dlqRegistry.test.ts elasticmq.conf .env.selfhost.example b4m-core/resource/src apps/workers/src/selfhost/main.ts
git commit -m "feat(video): wire the generation-job queue, worker and self-host runner"
```

---

### Task 10: Sweeper cron (hosted + self-host) and end-to-end verification

**Files:**
- Create: `apps/workers/src/cron/generationJobSweep.ts`, `generationJobSweep.test.ts`
- Create: `apps/workers/src/selfhost/generationJobSweep.ts`
- Modify: `infra/cron.ts` (new `sst.aws.Cron` + export), `apps/workers/src/selfhost/main.ts` (register)

**Interfaces:**
- Consumes: `runGenerationJobSweep` (Task 6), `generationJobRepository`, `enqueueGenerationJob` (Task 9).
- Produces: `handler` (cron Lambda) and `runGenerationJobSweepCron(): Promise<{ requeued: number }>`; `registerGenerationJobSweep(worker: SelfHostWorker): void`.

- [ ] **Step 1: Write the failing cron test**

```ts
import { describe, expect, it, vi } from 'vitest';

const runGenerationJobSweep = vi.fn(async () => ({ requeued: 2 }));
vi.mock('@bike4mind/services/generationJobs', () => ({ runGenerationJobSweep }));
vi.mock('@server/utils/connectDB', () => ({ connectDB: vi.fn(async () => undefined) }));
vi.mock('@server/generationJobs/wiring', () => ({ enqueueGenerationJob: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ generationJobRepository: {} }));
import { runGenerationJobSweepCron } from './generationJobSweep';

describe('generationJobSweep cron', () => {
  it('connects and runs one sweep', async () => {
    expect(await runGenerationJobSweepCron()).toEqual({ requeued: 2 });
    expect(runGenerationJobSweep).toHaveBeenCalledTimes(1);
  });
});
```

Copy the exact module paths for `connectDB` and `Logger` from `apps/workers/src/cron/questTimeoutSweep.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bike4mind/workers exec vitest run src/cron/generationJobSweep.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement (mirror `questTimeoutSweep.ts`)**

```ts
/**
 * Re-enqueues generation jobs whose SQS message was lost or whose worker died mid-step.
 * Schedule: rate(5 minutes) on production and dev (infra/cron.ts generationJobSweep).
 * Self-host equivalent: apps/workers/src/selfhost/generationJobSweep.ts.
 */
import { generationJobRepository } from '@bike4mind/database';
import { runGenerationJobSweep } from '@bike4mind/services/generationJobs';
import { Logger } from '@bike4mind/observability';
import { connectDB } from '@server/utils/connectDB';
import { enqueueGenerationJob } from '@server/generationJobs/wiring';

export async function runGenerationJobSweepCron(): Promise<{ requeued: number }> {
  await connectDB();
  return runGenerationJobSweep({
    repository: generationJobRepository,
    enqueue: enqueueGenerationJob,
    now: () => new Date(),
    logger: new Logger({ metadata: { handler: 'generationJobSweep' } }),
  });
}

export const handler = async () => runGenerationJobSweepCron();
```

`apps/workers/src/selfhost/generationJobSweep.ts`:

```ts
import { runGenerationJobSweepCron } from '@workers/cron/generationJobSweep';
import type { SelfHostWorker } from './selfHostWorker';

// Matches the hosted rate(5 minutes) in infra/cron.ts.
export const GENERATION_JOB_SWEEP_INTERVAL_MS = 5 * 60_000;

export function registerGenerationJobSweep(worker: SelfHostWorker): void {
  worker.registerScheduledTask('generationJobSweep', GENERATION_JOB_SWEEP_INTERVAL_MS, async () => {
    await runGenerationJobSweepCron();
  }, { runOnStartup: true });
}
```

Register in `apps/workers/src/selfhost/main.ts` next to `registerQuestTimeoutSweep(worker);` (~L94).

In `infra/cron.ts`, next to `questTimeoutSweepCron` (~L712):

```ts
const generationJobSweepCron = new sst.aws.Cron('generationJobSweep', {
  schedule: 'rate(5 minutes)',
  function: {
    vpc: lambdaVpc,
    handler: 'apps/workers/src/cron/generationJobSweep.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, generationJobQueue],
    timeout: '2 minutes',
    logging: { retention: '3 days' },
    environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
  },
  enabled: ['production', 'dev'].includes($app.stage),
});
```

Import `generationJobQueue` from `./queues`, and add `generationJobSweepCron` to the `export { ... }` list (~L1002). `enqueueGenerationJob` resolves the URL via `getSourceQueueUrl`, which reads the `sourceQueueUrls` Linkable: also link `sourceQueueUrls` (from `./web` or wherever it is defined) if the cron cannot otherwise resolve it - check how `questTimeoutSweep` reaches `generationCallbackQueue` (it uses `Resource.generationCallbackQueue?.url`, a direct link) and, if simpler, give `enqueueGenerationJob` a fallback to `Resource.generationJobQueue.url` when `sourceQueueUrls` lacks the entry.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @bike4mind/workers exec vitest run src/cron/generationJobSweep.test.ts src/selfhost`
Expected: PASS.

- [ ] **Step 5: Full verification gate**

Dispatch to a verify agent: `pnpm turbo:core:build && pnpm turbo:typecheck && pnpm turbo:test && pnpm lint:check`.
Expected: all green. Report only failing lines.

- [ ] **Step 6: Live self-host check of delayed re-enqueue**

Using the local self-host harness (see the selfhost harness reference in memory), boot with the branch, then from a Node REPL in the workers container (or a one-off script under `packages/scripts`) call `createVideoJob` through `getVideoJobDeps()` for a seeded user with prompt `'a cat'` on `test-video`. Expected within ~60s: the job document goes `pending -> running -> storing -> succeeded`, `payload.output.location === 'files'`, a FabFile of type `VIDEO` exists for the user, and the worker log shows delayed re-enqueues arriving after their delay. Repeat with `'a cat [blocked]'` and confirm the user's credit balance returns to its starting value. Record the observed transitions for the PR's test guide.

- [ ] **Step 7: Commit and open PR 1b**

```bash
git add apps/workers/src/cron/generationJobSweep.ts apps/workers/src/cron/generationJobSweep.test.ts apps/workers/src/selfhost infra/cron.ts
git commit -m "feat(video): sweep stalled generation jobs on a 5-minute schedule"
```

Open PR 1b with `/ship` as a draft stacked on PR 1a; body `Part of #3890`, including the self-host transcript from Step 6 and a preview test guide (create a job via a temporary script against the preview, since no public surface exists until plan 2).

---

## Spec coverage (plan 1 scope)

| Spec section | Task |
|---|---|
| 5.1 capabilities, 5.2 request + validation | 1 |
| 5.3 provider interface, registry, test provider | 4 |
| 5.4 GenerationJob | 5 |
| 6.1-6.6 lifecycle, lease, idempotency, orphaned submit, backoff, deadline, sweeper, cancel | 6, 10 |
| 6.7 notifications (websocket) | 7, 9 |
| 7 storage (one copy, Files-first, generated fallback, media-only) | 2, 8, 9 |
| 11 billing (hold, settle on actual duration, release) | 3, 8 |
| 12 admin settings | 7 |
| 13 logging / alarms (DLQ, orphaned submit, stuck terminal handling) | 6, 9 |
| 14 infrastructure + self-host | 9, 10 |
| 16 testing (conformance suite, engine, kind, test provider) | 4, 6, 8 |
| 8 API, 9 studio, 10 agent tool, 15 Sora removal, real adapters | plans 2-5 |
