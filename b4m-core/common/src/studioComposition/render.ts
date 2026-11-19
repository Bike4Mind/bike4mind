import { z } from 'zod';
import { GENERATION_JOB_STATES } from '../types/entities/GenerationJobTypes';
import { STUDIO_OUTPUT_ASPECT_RATIOS, type StudioOutputAspectRatio, type StudioTimeline } from './timeline';

/**
 * The `render` generation job: ffmpeg turns one Production timeline into one MP4 per output size. The job engine
 * (b4m-core/services/src/renderJobs) owns the lifecycle and billing; a separate render worker
 * (apps/workers/src/render) does the encode. The two only meet through the render queue message and the status
 * object below, so the worker never writes the job document.
 */

/** Longest one encode may run once a worker claims it; the queue visibility and task protection are keyed on it. */
export const STUDIO_RENDER_MAX_WALL_CLOCK_MS = 30 * 60_000;

/**
 * Time a job may wait for a worker (a scale-out from zero, or more outputs than tasks) before its encode starts,
 * so queueing does not eat the encode budget. Past cap + allowance the engine fails and refunds the job.
 */
export const STUDIO_RENDER_QUEUE_ALLOWANCE_MS = 30 * 60_000;

export const STUDIO_RENDER_JOB_DEADLINE_MS = STUDIO_RENDER_MAX_WALL_CLOCK_MS + STUDIO_RENDER_QUEUE_ALLOWANCE_MS;

/** How many outputs one export may render at once; matches the timeline's own output cap. */
export const STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT = 8;

/**
 * Admin-tunable price, in USD per started output second, for each aspect ratio. The values are placeholders until
 * render pricing is decided; the hold and the settlement both read the snapshot taken at create.
 */
export const StudioRenderPricingSchema = z.object({
  usdPerOutputSecond: z.object(
    Object.fromEntries(STUDIO_OUTPUT_ASPECT_RATIOS.map(ratio => [ratio, z.number().min(0).max(10)])) as Record<
      StudioOutputAspectRatio,
      z.ZodNumber
    >
  ),
});
export type StudioRenderPricing = z.infer<typeof StudioRenderPricingSchema>;

export const DEFAULT_STUDIO_RENDER_PRICING: StudioRenderPricing = {
  usdPerOutputSecond: { '16:9': 0.01, '9:16': 0.01, '1:1': 0.01, '4:5': 0.01 },
};

/** Output seconds are billed per started second, so a 15.2s timeline bills 16. */
export const studioRenderBilledSeconds = (timeline: Pick<StudioTimeline, 'durationMs'>): number =>
  Math.ceil(timeline.durationMs / 1000);

export const estimateStudioRenderUsd = (
  timeline: Pick<StudioTimeline, 'durationMs'>,
  aspectRatio: StudioOutputAspectRatio,
  pricing: StudioRenderPricing
): number => studioRenderBilledSeconds(timeline) * pricing.usdPerOutputSecond[aspectRatio];

/** The render queue message: the worker loads everything else from the job. */
export const StudioRenderQueueMessageSchema = z.object({ jobId: z.string().regex(/^[0-9a-f]{24}$/) });
export type StudioRenderQueueMessage = z.infer<typeof StudioRenderQueueMessageSchema>;

/**
 * Image types the render worker can decode, with the extension its ffmpeg input needs (image2 picks the
 * decoder from it). Export admission refuses other image types up front; apps/workers/src/render reads this.
 */
export const STUDIO_RENDER_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
};

/** The bare, lower-cased MIME type (parameters stripped), as the image table keys it. */
export const studioRenderBareMimeType = (mimeType: string | null | undefined): string =>
  mimeType?.split(';')[0].trim().toLowerCase() ?? '';

/**
 * What the worker reports, written as JSON to the generated bucket at studioRenderStatusKey. The engine's poll step
 * reads it; a missing object means the worker has not picked the job up yet.
 */
export const StudioRenderStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running'), progress: z.number().min(0).max(1), updatedAt: z.string() }),
  z.object({
    state: z.literal('succeeded'),
    s3Key: z.string().min(1),
    bytes: z.number().int().positive(),
    durationSeconds: z.number().positive(),
    updatedAt: z.string(),
  }),
  z.object({ state: z.literal('failed'), message: z.string().max(500), updatedAt: z.string() }),
]);
export type StudioRenderStatus = z.infer<typeof StudioRenderStatusSchema>;

// infra/buckets.ts expires this prefix (expire-studio-render-scratch); keep the two in sync.
const STUDIO_RENDER_PREFIX = 'studio-render';

export const studioRenderStatusKey = (jobId: string): string => `${STUDIO_RENDER_PREFIX}/${jobId}/status.json`;
export const studioRenderOutputKey = (jobId: string): string => `${STUDIO_RENDER_PREFIX}/${jobId}/output.mp4`;

/** One render job as the Productions export panel reads it; holds, leases and the timeline stay server-side. */
export const StudioRenderJobSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  compositionId: z.string(),
  state: z.enum(GENERATION_JOB_STATES),
  progress: z.number().min(0).max(1).nullable(),
  output: z.object({
    id: z.string(),
    aspectRatio: z.enum(STUDIO_OUTPUT_ASPECT_RATIOS),
    width: z.number().int(),
    height: z.number().int(),
  }),
  /** Credits held for this render; what a success settles against. */
  heldCredits: z.number().nullable(),
  settledCredits: z.number().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  file: z.object({ fileId: z.string().nullable(), bytes: z.number(), durationSeconds: z.number() }).nullable(),
  createdAt: z.string(),
});
export type StudioRenderJob = z.infer<typeof StudioRenderJobSchema>;

export const StudioRenderJobListSchema = z.object({ data: z.array(StudioRenderJobSchema) });
export const StudioRenderCreateResponseSchema = z.object({ groupId: z.string(), jobs: z.array(StudioRenderJobSchema) });

/** The export request: the timeline output ids to render, one job each. */
export const StudioRenderCreateInputSchema = z.strictObject({
  outputIds: z.array(z.string().min(1).max(64)).min(1).max(STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT),
});
