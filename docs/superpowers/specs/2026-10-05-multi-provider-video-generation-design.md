# Multi-provider video generation - design

- **Status:** approved design, pending spec review
- **Date:** 2026-10-05
- **Replaces:** the OpenAI Sora video pipeline (the OpenAI Videos API was removed on 2026-09-24)

## 1. Goal

Bring video generation back to Bike4Mind as a provider-agnostic capability that outlives any single vendor. Adding a provider must mean writing one adapter and one capability declaration - no UI, contract, billing or queue changes.

### Success criteria

- A user can generate a 3-10s clip from text or from an image in their library, from the **public API**, the **agent tool**, and a **dedicated studio UI**.
- v1 ships three providers that exercise three different API shapes: **Gemini Omni Flash** (Interactions API), **Google Veo 3.1** (long-running operation), **xAI Grok Imagine** (request id + poll).
- A crash at any point never double-charges a user and never loses a paid result that the provider delivered.
- No worker sits idle waiting on a provider; per-step Lambda time is seconds, not minutes.
- Every finished video is retrievable by the user regardless of whether a Files copy could be made.

### Non-goals (v1)

- Extend / edit / video-to-video, first+last-frame interpolation, multi-reference inputs. The model is designed so these are additive `VideoMode`s.
- Migrating image, music or TTS generation onto the new job engine. The engine is generic so they can follow in their own PRs.
- Provider webhooks. Poll-only in v1; the engine accepts an early-poll trigger so webhooks are an additive accelerator later.
- The `/gen_video` slash command. It is retired.

## 2. Current state and why it is replaced

The Sora pipeline is still in the tree: `VideoModels` enum, `OpenAISoraVideoService`, `VideoGenerationService` (`b4m-core/services/src/llm/VideoGeneration.ts`), `videoGenerationQueue`, `/api/v1/video-generations`, `/gen_video`, `VideoContainer`. Its upstream API no longer exists, and its shape blocks a second provider:

- The OpenAI vendor and OpenAI key are hard-coded in the service.
- Request schemas encode Sora's discrete 4/8/12s durations and four pixel sizes.
- A single 15-minute Lambda submits, sleeps and polls in a loop: idle compute, a crash loses the provider handle, no clean cancel.
- Results are a bare S3 path on `quest.videos`, invisible outside a quest.
- The cost calculator holds placeholder Sora prices.

We replace it rather than extend it.

## 3. Provider landscape (research, 2026-10-05)

| Provider | Call shape | Durations | Aspect / resolution | Audio | Output delivery | Price unit |
|---|---|---|---|---|---|---|
| Gemini Omni Flash (`gemini-omni-1.1-flash`) | Interactions API `interactions.create`, `background: true` + poll interaction | range 3-10s | 16:9, 9:16; 360p/720p/1080p/4k; 24fps | prompt-steered | inline base64 (<4MB) or Files API URI needing the API key | per second (token-denominated, ~$0.10/s at 720p) |
| Google Veo 3.1 (std / fast / lite) | `models.generateVideos` long-running op + `operations.getVideosOperation` | discrete 4/6/8s | 16:9, 9:16; 720p/1080p/4k (lite: no 4k) | always | Google-hosted file, 2-day retention, API key | per second |
| xAI Grok Imagine video | `POST /v1/videos/generations` -> `request_id` + poll | up to 15s | configurable aspect; 480p/720p/1080p | unverified | URL | per second |

Divergences that drive the design: continuous vs discrete durations; aspect+tier rather than pixel sizes; per-provider audio behaviour; heterogeneous output delivery with short or authenticated retention; per-second vs per-clip vs per-token pricing elsewhere in the market.

**Unverified, must be confirmed in implementation:** the Omni polling method in `@google/genai` (JS) and the minimum SDK version; the Omni blocked/failed response shape; Omni Files retention; Omni rate limits; xAI audio and output URL lifetime. Each adapter's conformance fixtures are recorded from real responses, which settles these.

## 4. Architecture overview

```
 public API --+                                          +--> VideoProvider: gemini-omni
 studio UI  --+--> VideoGenerationService.create() ------+--> VideoProvider: veo
 agent tool --+     (validate, reserve credits,          +--> VideoProvider: xai
                     persist GenerationJob, enqueue)     +--> VideoProvider: test (non-prod)
                              |
                              v
                     generationJobQueue (SQS, {jobId})
                              |
                              v
                     GenerationJobEngine.step(jobId)
                     lease -> run step for state -> commit -> re-enqueue w/ delay
                              |
                              v
             S3 (job-owned object) -> FabFile copy (gated) -> settle credits
                              |
                              v
             websocket generation_job_updated / completion callback / quest link
```

Layers, each independently testable:

1. **Common** (`b4m-core/common/src/videoGeneration/`): provider-neutral types, Zod schemas, `VideoModelCapabilities`, `validateAgainstCapabilities`, `estimateVideoCost`. Pure, shared by server and client.
2. **Providers** (`b4m-core/utils/src/videoGeneration/providers/<id>/`): one adapter per provider implementing `VideoProvider`, plus its capability declarations.
3. **Generation-job engine** (`b4m-core/services/src/generationJobs/`): generic durable step machine. Knows nothing about video.
4. **Video job kind** (`b4m-core/services/src/videoGeneration/`): registers the `video` kind with the engine; owns validation, credit reservation/settlement, storage and FabFile creation.
5. **Surfaces:** contract-based API routes in `apps/client/pages/api/v1/`, the studio route in the SPA, the `video_generation` agent tool.

## 5. Domain model

### 5.1 Capabilities (declared data)

```ts
type VideoMode = 'text_to_video' | 'image_to_video';
type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';
type ResolutionTier = '360p' | '480p' | '720p' | '1080p' | '4k';

type DurationCapability =
  | { kind: 'range'; min: number; max: number; step: number }
  | { kind: 'discrete'; values: readonly number[] };

type VideoPricing =
  | { unit: 'per_second'; usdByResolution: Partial<Record<ResolutionTier, number>> }
  | { unit: 'per_clip'; usdByDurationAndResolution: ReadonlyArray<{ durationSeconds: number; resolution: ResolutionTier; usd: number }> };

type VideoModelCapabilities = {
  modelId: VideoModelId;
  provider: VideoProviderId;
  displayName: string;
  modes: readonly VideoMode[];
  duration: DurationCapability;
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly ResolutionTier[];
  defaults: { durationSeconds: number; aspectRatio: AspectRatio; resolution: ResolutionTier };
  audio: 'always' | 'optional' | 'none';
  pricing: VideoPricing;
  deprecationDate?: string;
};
```

`VideoModelId` and `VideoProviderId` are Zod enums derived from the registered declarations, so a model id that is not declared cannot reach a provider. The registry replaces `VideoModels` / `VIDEO_SIZE_CONSTRAINTS` in `b4m-core/common/src/models.ts`; `ModelInfo.type: 'video'` entries for the model picker and model discovery are generated from it.

### 5.2 Request

```ts
const VideoGenerationRequestSchema = z.object({
  model: VideoModelIdSchema,
  mode: z.enum(['text_to_video', 'image_to_video']),
  prompt: z.string().min(1).max(4000),
  durationSeconds: z.number().positive(),
  aspectRatio: AspectRatioSchema,
  resolution: ResolutionTierSchema,
  inputImageFileId: z.string().optional(), // required iff mode === 'image_to_video'
  audio: z.boolean().optional(),           // honoured only when capability is 'optional'
});
```

`validateAgainstCapabilities(request, caps)` returns a discriminated result and the caller fails loudly with a specific code (`unsupported_duration`, `unsupported_aspect_ratio`, `unsupported_resolution`, `unsupported_mode`, `missing_input_image`). There is no silent rounding anywhere on the server. The studio clamps on model switch and tells the user what changed.

### 5.3 Provider interface

Every method is a single bounded call. No method sleeps or loops.

```ts
type ProviderJobHandle = { provider: VideoProviderId; data: Record<string, unknown> }; // opaque, JSON-persisted

type ProviderOutput =
  | { kind: 'inline'; base64: string; contentType: string }
  | { kind: 'url'; url: string; requiresAuth: boolean; contentType?: string };

type ProviderPollResult =
  | { status: 'running'; progress?: number }
  | { status: 'succeeded'; output: ProviderOutput; reportedDurationSeconds?: number }
  | { status: 'blocked'; reason?: string; billed?: boolean; raw: unknown }
  | { status: 'failed'; retryable: boolean; message: string; raw: unknown };

type VideoProviderContext = { apiKey: string; logger: Logger; signal?: AbortSignal };

interface VideoProvider {
  readonly id: VideoProviderId;
  readonly models: readonly VideoModelCapabilities[];
  submit(request: ValidatedVideoRequest, input: ResolvedInputs, ctx: VideoProviderContext): Promise<ProviderJobHandle>;
  poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult>;
  fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer>;
  cancel?(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<void>;
}
```

- `ResolvedInputs` carries the input image bytes/URL already fetched from the user's library and access-checked; adapters never touch our database.
- `fetchOutput` returns the clip as a `Buffer`, bounded by `MAX_VIDEO_OUTPUT_BYTES` (256MB; a 10s 4k clip is well under it) and rejected above it. Buffering is deliberate: `S3Storage.upload` and `createFabFile` both take a `Buffer`, and streaming would mean reworking FabFile creation for no gain at 3-10s clip sizes. The Lambda is sized for it.
- `blocked.billed` is set only when the provider is known to have charged for a clip it generated and then withheld (xAI reads it from the moderated response's `usage.cost_in_usd_ticks`). A billed block settles the hold at the requested duration; a submit-time or unbilled block releases it in full.
- Adapters map provider statuses into `ProviderPollResult` and classify errors (`retryable`). They never throw for an expected provider outcome; they throw only for programmer errors and transport failures, which the engine treats as retryable.
- A provider registry (`getVideoProvider(id)`) replaces the `aiVideoService` vendor switch. API keys resolve through the existing `getEffectiveLLMApiKeys` (user key -> admin demo key -> env), keyed by provider.

### 5.4 `GenerationJob` (generic) and the `video` kind

New Mongoose model in `packages/database`. `kind` is a plain enum field over a shared `GENERATION_JOB_KINDS` const (the repo uses no Mongoose discriminators); kind-specific data lives in a typed `payload` sub-document.

| Field | Notes |
|---|---|
| `kind` | `'video'` (enum; future: `'image'`, `'music'`, ...) |
| `ownerType`, `ownerId` | personal or org ownership, symmetric |
| `requestedBy` | user id |
| `source` | `'api' \| 'studio' \| 'agent'` |
| `state` | see section 6 |
| `attempts`, `leaseUntil`, `nextPollAt`, `submitAttemptedAt`, `deadlineAt` | engine bookkeeping |
| `idempotencyKey` | unique per owner when present |
| `creditHold` | `{ ownerId, ownerType, reservedCredits }` or null when credits are not enforced; `settledCredits` |
| `error` | `{ code, message }`; `rawProviderError` stored separately, `select: false` |
| `callbackUrl`, `questId` | optional links |
| video fields | `request`, `providerHandle`, `output: { s3Key, contentType, bytes, durationSeconds, fileId? }` |

Indexes declared together at the bottom of the schema: `{ ownerType, ownerId, createdAt: -1 }` (history), `{ state, nextPollAt }` (sweeper), `{ ownerId, idempotencyKey }` unique partial. A migration ensures the indexes.

## 6. Job lifecycle

### 6.1 States

```
pending --submit--> running --poll: succeeded--> storing --> succeeded
                     |  \--poll: running--> re-enqueue with delay
                     |--poll: blocked--> blocked    (released; settled at the requested duration if the provider billed it)
                     \--poll: failed (non-retryable)--> failed (reservation released)
any non-terminal --cancel--> cancelled (provider.cancel if supported; reservation released)
```

Terminal: `succeeded`, `failed`, `blocked`, `cancelled`.

### 6.2 Engine contract

A job kind registers:

```ts
type JobKindHandler<J> = {
  submit(job: J): Promise<StepResult<J>>;
  poll(job: J): Promise<StepResult<J>>;
  store(job: J): Promise<StepResult<J>>;
  onTerminal(job: J): Promise<void>;   // settle or release credits, notify, callback
  maxWallClockMs: number;
};
```

The engine owns states, leases, retries, backoff, the deadline, cancel and notifications. A kind never writes `state` directly.

### 6.3 One step per message

The SQS message body is `{ jobId }`. The worker:

1. **Leases** the job with a conditional `findOneAndUpdate({ _id, state: { $nin: terminal }, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { leaseUntil: now + handlerTimeout + 30s })`. The lease always outlives the Lambda that holds it, so two workers can never run the same step concurrently. No match means a duplicate or stale message: exit successfully.
2. Runs the handler step for the current state.
3. Commits the resulting state and clears the lease **in one update**.
4. If non-terminal, re-enqueues `{ jobId }` with `DelaySeconds` from the backoff schedule.

### 6.4 Idempotency and the orphaned-submit gap

- `submitAttemptedAt` is written *before* calling `provider.submit`. The provider handle and the transition to `running` are written in one update after it returns.
- Adapters distinguish a submit the provider **definitively rejected** (an HTTP error response such as 4xx or 429: nothing was created) from one whose outcome is **unknown** (timeout, connection reset). A definitive rejection clears `submitAttemptedAt` and retries normally.
- A retry that finds `state: pending` with `submitAttemptedAt` still set (outcome unknown) does **not** resubmit (the provider may already be generating). It moves the job to `failed` with `orphaned_submit`, releases the reservation, logs and alarms.
- None of the v1 providers accept a client idempotency key, so this gap cannot be closed in general: the platform may pay for an orphaned provider job, but the user is never charged twice and never charged for a result they cannot get. If a provider later offers idempotency keys, its adapter can pass `jobId` and the gap closes for it.
- `storing` is idempotent: before creating a FabFile it looks one up by the job's tag; the generated-bucket fallback writes a deterministic key (`generated-video/<ownerId>/<jobId>.mp4`), so a re-run overwrites the same object.
- Transport failures and `retryable: true` provider failures re-enqueue with backoff, up to a per-step attempt cap, then fail with `provider_error`.

### 6.5 Backoff, deadline and the sweeper

- Poll delays: 5s, 10s, 20s, 30s, then 60s capped (SQS `DelaySeconds` max is 900s).
- `deadlineAt = createdAt + maxWallClockMs` (video: 20 minutes). A step past the deadline fails the job with `provider_timeout` and calls `cancel` when supported.
- A scheduled sweeper (every 5 minutes) re-enqueues non-terminal jobs whose `nextPollAt` is more than 5 minutes overdue, covering lost messages and expired leases.

### 6.6 Cancel

`POST .../{id}/cancel` sets a `cancelRequested` flag and enqueues an immediate step. The next lease observes it, calls `provider.cancel` when supported, and moves to `cancelled`. Cancelling a job in `storing` is rejected (the result is already paid for) and returns the job as-is.

### 6.7 Notifications

Every state commit publishes `generation_job_updated` (`{ jobId, kind, state, progress?, output? }`) to the owner over the existing websocket fanout. Completion callbacks for API callers and quest updates for agent jobs are added with those surfaces (plan 2 and plan 5). The existing callback machinery (`dispatchQuestCallback`) is quest-keyed, so plan 2 decides between a job-keyed variant and a quest per job.

## 7. Storage and delivery

- **One copy, never two.** The `storing` step first creates a FabFile (`createFabFile`, `KnowledgeType.VIDEO`, prefix `generated-video`, tagged `generated` + the job id), which uploads into the files bucket. If that is refused (storage limit, max file size), it writes the clip to the generated-media bucket instead. The job records `output: { location: 'files' | 'generated', s3Key, fileId? }`.
- Completion never depends on the Files copy: a quota-blocked user still gets their paid video.
- There is no per-user opt-out for video (unlike `saveGeneratedAudio`): every video is a deliberate, paid request, so it is always offered to Files.
- The API **never returns video bytes.** A succeeded job exposes `output.url`, a short-lived signed URL minted on read, with `expiresAt`. This follows the generated-audio delivery work, which removed byte responses over the serverless response ceiling.
- Playback in the client uses the signed S3/CloudFront URL, which the existing `media-src` CSP already allows. No `data:` URLs.

## 8. Public API

All routes are contract-based (`b4m-core/common/src/api-contract/contracts/videoGeneration.contract.ts`), follow `CONVENTIONS.md`, require the `ai:generate` scope, and use the shared error envelope. This replaces the existing Sora-shaped contract in place, a **breaking change** (`feat(api)!`); the old shape cannot work since its upstream API is gone. The legacy alias `/api/ai/generate-video` is removed.

| Method + path | Behaviour |
|---|---|
| `GET /api/v1/video-models` | Capabilities of every model enabled by admin settings and usable with an available key |
| `POST /api/v1/video-generations` | Validates, reserves credits, creates the job, enqueues; **202** with the job. Honours `Idempotency-Key` (same key + same owner returns the existing job; same key + different body is 422) |
| `GET /api/v1/video-generations/{id}` | The job; `output` with a fresh signed URL when succeeded |
| `GET /api/v1/video-generations` | Cursor-paginated history for the caller (filter by `state`, `source`) |
| `POST /api/v1/video-generations/{id}/cancel` | Requests cancellation; returns the job |

Error codes: `unsupported_duration`, `unsupported_aspect_ratio`, `unsupported_resolution`, `unsupported_mode`, `missing_input_image`, `input_image_not_found`, `model_disabled`, `insufficient_credits`, plus job-level `content_blocked`, `provider_timeout`, `provider_error`, `orphaned_submit`, `region_unavailable`. User-facing messages are derived from the code, never from raw provider text.

## 9. Studio UI

A Tanstack route (`/studio/video`), MUI Joy.

- **Form**, rendered from `GET /video-models`: model picker; mode; prompt; image picker from the library for image-to-video; duration as a slider (range) or segmented control (discrete); aspect ratio; resolution; audio toggle when `optional`; a live credit estimate from `estimateVideoCost`. Switching models clamps unsupported values and shows what changed.
- **Gallery** of the user's jobs from `GET /video-generations`, newest first. Cards show live state and progress; `generation_job_updated` events are written into the React Query cache, with polling as fallback when the socket is down. Succeeded cards play inline and offer Open in Files, Download, and Cancel while running.
- `VideoJobCard` is a standalone component keyed by `jobId`, reused by the chat for agent jobs.
- Server data in React Query; form state local (or a small Zustand store if shared across the route).

## 10. Agent tool

- Tool name `video_generation`, registered on the existing tool surfaces.
- Its input schema is generated from the enabled models' capabilities, so the LLM only sees valid models, durations and aspects.
- **Non-blocking:** the tool calls `VideoGenerationService.create({ source: 'agent', questId })`, returns `{ jobId, estimatedSeconds }` immediately, and the chat renders `VideoJobCard` for that job. The turn continues.
- **Billing is the engine's.** The tool opts out of ToolBuilder credit reservation and `settleToolCredits`; the job reserves and settles. One billing path for all surfaces.
- `toolSideEffects` classifies it `external`.

## 11. Billing and credits

1. **Create:** hold `estimateVideoCost(caps, request)` against the personal or org balance, including the org cap check. Insufficient credits fails before any provider call with `insufficient_credits`. The hold is a serialisable `CreditHold` stored on the job, so it can be settled or released by a later Lambda. `holdCredits` / `settleCreditHold` / `releaseCreditHold` are extracted from `apps/client/server/billing/reserveRequestCredits.ts` into `b4m-core/services/src/creditService`, and `reserveRequestCredits` is rewritten on top of them (one implementation of the money movement).
2. **Succeeded:** settle on the actual duration (provider-reported, else the requested duration; capability validation already pins the requested duration to what the model produces) via `deductCreditsWithOrgSupport`, transaction type `video_generation_usage`, and write a usage event.
3. **Blocked / failed / cancelled / orphaned:** release the full reservation.
4. **Own keys are billed like every other path.** Chat, image and the old video pipeline all charge platform credits regardless of whose key served the call, and `getEffectiveLLMApiKeys` cannot tell the caller which key it returned. Changing that is a platform-wide policy change and out of scope.
5. `estimateVideoCost` is a pure function in `common`, used by the studio for display and by the server for reservation, so the shown estimate and the reservation cannot drift. Prices live in capability declarations, sourced from vendor price pages and converted with `usdToCredits`.

`enforceCredits` and org caps apply unchanged.

## 12. Admin settings

A `videoGeneration` settings block with a per-model enable map. Gemini Omni Flash defaults to enabled; Veo and xAI default to disabled. `GET /video-models`, the agent tool schema and the studio all read it, so disabling a model removes it everywhere at once.

## 13. Errors, safety, observability

- **Safety:** provider-side filtering (surfaced as `blocked`, not billed), plus the existing FabFile moderation pipeline on the Files copy. Input images come from the user's library and have already passed that pipeline.
- **Logging:** one structured line per step: `{ jobId, kind, provider, model, step, durationMs, outcome }`. Raw provider errors are stored on the job (`select: false`) and never returned to clients.
- **Metrics:** jobs by terminal state per provider; submit-to-terminal latency; orphaned submits.
- **Alarms:** `generationJobQueue` DLQ; any `orphaned_submit`; per-provider failure-rate rise.

## 14. Infrastructure

- New `generationJobQueue` + DLQ in `infra/queues.ts`, wired into `dlqRegistry`, `dlqAlarms` and `logMonitor`. Handler timeout 5 minutes and 2048MB memory, sized for the `storing` step (download + upload of a 4k clip); poll steps finish in seconds. Visibility timeout 6 minutes.
- Sweeper cron in `apps/workers/src/cron`.
- `videoGenerationQueue` and its handler are removed.
- **Self-host:** the same handler runs under the self-host worker runner. Delayed re-enqueue must be supported there; planning confirms the self-host queue implements `DelaySeconds` and covers every file that self-host queue parity requires.

## 15. Removal of Sora

Delete: `OpenAISoraVideoService`, the `aiVideoService` factory, `VideoModels` / `VIDEO_SIZE_CONSTRAINTS`, `schemas/sora.ts`, `SoraVideoCostCalculator`, the Sora catalog entries in `openaiBackend.ts`, `VideoGenerationService` (old), `videoGenerationQueue` + handler, `/gen_video` and `VideoGenerationCommand`, the `/api/ai/generate-video` alias, and the related tests. Keep a read-only renderer so existing `quest.videos` in old chats still play.

## 16. Testing

- **Provider conformance suite:** `describeVideoProviderConformance(adapter, fixtures)` runs every adapter through submit, poll-running, succeeded-inline, succeeded-url, blocked, failed (retryable and not), and `fetchOutput` (including the size cap), against recorded HTTP fixtures (msw). A provider is done when it passes.
- **Engine:** fake job kind + `createMongoServer()`; every transition, duplicate and out-of-order messages, a simulated crash after each step, lease expiry, deadline, sweeper, cancel in each state, orphaned submit.
- **Video kind:** capability validation, reservation / settlement / release arithmetic, own-key path, persist-check skip path, deterministic S3 key.
- **API:** each contract endpoint, idempotency-key semantics, error codes, scope enforcement.
- **UI:** capability-driven form (range vs discrete duration, clamping on model switch, estimate), `VideoJobCard` states.
- **Test provider:** a deterministic `test` provider registered only outside production (as `TestImageService` is for images), so preview E2E runs exercise studio and agent tool end to end without paid calls. Each real adapter gets a manual live check.

## 17. Delivery plan (finalised in the implementation plan)

1. Common types and schemas, generation-job engine, `test` provider, queue and sweeper wiring (split into two PRs: domain + credit holds, then engine + video kind).
2. Gemini Omni Flash adapter, the new public API and Sora removal (removed in the same PR that replaces its endpoint, so the contract never has a gap).
3. Veo 3.1 and xAI adapters.
4. Studio UI.
5. Agent tool and chat `VideoJobCard`.

Phase 2 ships xAI Grok Imagine 1.5 and Veo 3.1 Fast; Omni stays disabled pending the upstream auth-key bug.

## 18. Open items

- Confirm the Omni Flash JS SDK surface and minimum `@google/genai` version; bump if needed (plan 2).
- Resolved: own keys are billed like every other path (section 11).
- Resolved: self-host runs the same handler via `apps/workers/src/selfhost/main.ts`; ElasticMQ honours per-message `DelaySeconds`; the queue is added to `elasticmq.conf`, `.env.selfhost.example` and the resource manifest (pinned by `selfHostQueueParity.test.ts`). A live self-host run verifies delayed re-enqueue.
- Resolved: one stored copy, in the files bucket or the generated bucket (section 7). The worker gets 2048MB memory and a 5-minute timeout to cover a 4k download and upload.
