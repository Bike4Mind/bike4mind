import { z } from 'zod';
import type { GenerationJobState, StudioCompositionTemplate, StudioOutputAspectRatio } from '@bike4mind/common';

/**
 * The Studio place's Productions tab: the account's Studio compositions, read and edited over
 * `/api/studio/compositions*` with the desktop bearer token (those routes are `jwtOnly`, so the
 * device-flow token passes; ownership is enforced server-side). Main validates every response
 * with the shared `@bike4mind/common` schemas and hands the renderer the small view models below.
 */

/** Composition and FabFile ids are Mongo ObjectIds. */
export const productionIdSchema = z.string().regex(/^[a-f0-9]{24}$/);

/** Timeline track, clip and output ids, as `StudioTimelineSchema` allows them. */
const timelineIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const productionsListRequestSchema = z.object({ skip: z.number().int().min(0).max(10_000).optional() }).strict();
export type ProductionsListRequest = z.infer<typeof productionsListRequestSchema>;

export const productionRefSchema = z.object({ id: productionIdSchema }).strict();
export type ProductionRef = z.infer<typeof productionRefSchema>;

export const productionRenameSchema = z
  .object({ id: productionIdSchema, title: z.string().trim().min(1).max(200) })
  .strict();
export type ProductionRename = z.infer<typeof productionRenameSchema>;

export const productionReorderSchema = z
  .object({
    id: productionIdSchema,
    trackId: timelineIdSchema,
    /** Every clip id on the track, in the new order. */
    clipIds: z.array(timelineIdSchema).min(1).max(500),
  })
  .strict();
export type ProductionReorder = z.infer<typeof productionReorderSchema>;

export const productionRenderRequestSchema = z
  .object({ id: productionIdSchema, outputIds: z.array(timelineIdSchema).min(1).max(8) })
  .strict();
export type ProductionRenderRequest = z.infer<typeof productionRenderRequestSchema>;

export const productionFileRefSchema = z.object({ fileId: productionIdSchema }).strict();
export type ProductionFileRef = z.infer<typeof productionFileRefSchema>;

export interface ProductionSummary {
  id: string;
  title: string;
  template: StudioCompositionTemplate;
  /** ISO 8601. */
  updatedAt: string;
}

export interface ProductionsPage {
  items: ProductionSummary[];
  /** The `skip` of the next page, or null once a short page says the list is exhausted. */
  nextSkip: number | null;
}

export interface ProductionClip {
  id: string;
  /** The shot this clip was cut from, else "Clip N" by position. */
  label: string;
  startMs: number;
  durationMs: number;
}

export interface ProductionVideoTrack {
  id: string;
  enabled: boolean;
  /** Sorted by start time. */
  clips: ProductionClip[];
}

export interface ProductionOutput {
  id: string;
  aspectRatio: StudioOutputAspectRatio;
  width: number;
  height: number;
}

export interface ProductionDetail extends ProductionSummary {
  durationMs: number;
  outputs: ProductionOutput[];
  videoTracks: ProductionVideoTrack[];
  /** Voice, music, sfx and caption clips, which this tab shows only as a count. */
  otherClipCount: number;
}

export interface ProductionRenderJob {
  id: string;
  groupId: string;
  state: GenerationJobState;
  /** 0..1 while running; null when the worker has not reported. */
  progress: number | null;
  output: ProductionOutput;
  errorMessage: string | null;
  /** The finished MP4's FabFile, once stored. */
  fileId: string | null;
  durationSeconds: number | null;
  /** ISO 8601. */
  createdAt: string;
}

export interface ProductionMedia {
  /** A `b4m-media:` URL; the renderer's CSP admits no remote origin. */
  url: string;
  mimeType: string;
}

/**
 * Why a call failed, as the tab acts on it:
 * - `not-enabled`: the Productions rollout gate refused the account (403 FEATURE_DISABLED).
 * - `not-found`: missing, or another user's (the server answers both with 404).
 * - `not-ready`: a finished render's file is not downloadable yet; ask again shortly.
 */
export type ProductionsErrorKind = 'signed-out' | 'not-enabled' | 'not-found' | 'not-ready' | 'failed';

export type ProductionsResult<T> =
  { ok: true; value: T } | { ok: false; error: { kind: ProductionsErrorKind; message: string } };

export interface ProductionsApi {
  list(request: ProductionsListRequest): Promise<ProductionsResult<ProductionsPage>>;
  get(ref: ProductionRef): Promise<ProductionsResult<ProductionDetail>>;
  rename(request: ProductionRename): Promise<ProductionsResult<ProductionDetail>>;
  /** Re-reads the production, puts the track's clips in this order back to back, and saves the timeline. */
  reorder(request: ProductionReorder): Promise<ProductionsResult<ProductionDetail>>;
  /** The production's recent render jobs, newest first. */
  renders(ref: ProductionRef): Promise<ProductionsResult<ProductionRenderJob[]>>;
  /** Start one render job per output. Billed to the account's active organization, as on the web. */
  render(request: ProductionRenderRequest): Promise<ProductionsResult<ProductionRenderJob[]>>;
  /** Download a finished render into the media folder (cached for the app run). */
  media(ref: ProductionFileRef): Promise<ProductionsResult<ProductionMedia>>;
}

export const RENDER_IN_FLIGHT_STATES: readonly GenerationJobState[] = ['pending', 'running', 'storing'];

export const isRenderInFlight = (job: Pick<ProductionRenderJob, 'state'>): boolean =>
  RENDER_IN_FLIGHT_STATES.includes(job.state);
