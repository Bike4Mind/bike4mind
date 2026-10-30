import { z } from 'zod';
import {
  ModalStillImageShapeSchema,
  ModalVideoShapeSchema,
  type ModalStillImage,
  type ModalStillImageField,
  type ModalVideo,
  type ModalVideoField,
} from '../types/entities/ModalTypes';

export const RELEASE_NOTES_SCHEMA_VERSION = 1;

export const ReleaseNoteCategorySchema = z.enum(['new', 'improved', 'fixed']);
export type ReleaseNoteCategory = z.infer<typeof ReleaseNoteCategorySchema>;

export const ReleaseNoteItemSchema = z.object({
  category: ReleaseNoteCategorySchema,
  text: z.string().min(1),
  // 1 = headline-worthy, 3 = minor
  importance: z.number().int().min(1).max(3),
  sourcePrs: z.array(z.number().int().positive()),
});
export type ReleaseNoteItem = z.infer<typeof ReleaseNoteItemSchema>;

export const ReleaseNoteStatusSchema = z.enum(['scheduled', 'hidden']);
export type ReleaseNoteStatus = z.infer<typeof ReleaseNoteStatusSchema>;

export const ReleaseNoteSchema = z.object({
  releaseTag: z.string().min(1),
  deployedSha: z.string().min(1),
  deployedAt: z.coerce.date(),
  headline: z.string(),
  summary: z.string(),
  items: z.array(ReleaseNoteItemSchema),
  audience: z.literal('public'),
  status: ReleaseNoteStatusSchema,
  // Not visible to readers before this instant (deployedAt + embargo).
  publishAt: z.coerce.date(),
  // Set by a human edit; a non-null value makes the note immune to regeneration.
  editedAt: z.coerce.date().nullable(),
  // Attached by an admin edit, never generated.
  video: ModalVideoShapeSchema.nullable().optional(),
  image: ModalStillImageShapeSchema.nullable().optional(),
  schemaVersion: z.number().int(),
});
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;

export const ReleaseNotesJobPrSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  labels: z.array(z.string()),
  customerNote: z.string().optional(),
  excerpt: z.string(),
});
export type ReleaseNotesJobPr = z.infer<typeof ReleaseNotesJobPrSchema>;

/** SQS body sent by the release workflow; consumed by the workers releaseNotes queue handler. */
export const ReleaseNotesJobPayloadSchema = z.object({
  kind: z.literal('release-notes'),
  schemaVersion: z.number().int(),
  releaseTag: z.string().min(1),
  // Interpolated into a Slack <url|label> link, so no whitespace or link delimiters.
  releaseUrl: z.string().regex(/^https:\/\/[^\s<>|]+$/),
  previousTag: z.string().nullable(),
  deployedSha: z.string().min(1),
  deployedAt: z.coerce.date(),
  prs: z.array(ReleaseNotesJobPrSchema),
});
export type ReleaseNotesJobPayload = z.infer<typeof ReleaseNotesJobPayloadSchema>;

export const ReleaseNotesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  modelId: z.string().default('gpt-4o-mini'),
  embargoHours: z.number().min(0).max(168).default(12),
  // Case-insensitive terms that must never reach customer-facing copy.
  denylist: z.array(z.string()).default([]),
  slackTeamId: z.string().optional(),
  slackChannelId: z.string().optional(),
});
export type ReleaseNotesConfig = z.infer<typeof ReleaseNotesConfigSchema>;

/**
 * Parses the stored `releaseNotesConfig` admin setting, which may arrive as a JSON string. An absent
 * setting parses to the defaults (disabled). Shared by the workers generator and the client routes.
 */
export function parseReleaseNotesConfig(raw: unknown) {
  let value: unknown = raw ?? {};
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  return ReleaseNotesConfigSchema.safeParse(value);
}

/** A release note video on the public wire: ModalVideo with snake_case keys. */
export const PublicReleaseNoteVideoSchema = z.object({
  landscape_url: z.string().nullable().optional(),
  landscape_poster_url: z.string().nullable().optional(),
  portrait_url: z.string().nullable().optional(),
  portrait_poster_url: z.string().nullable().optional(),
});
export type PublicReleaseNoteVideo = z.infer<typeof PublicReleaseNoteVideoSchema>;

export const toPublicReleaseNoteVideo = (video: ModalVideo): PublicReleaseNoteVideo => ({
  landscape_url: video.landscapeUrl ?? null,
  landscape_poster_url: video.landscapePosterUrl ?? null,
  portrait_url: video.portraitUrl ?? null,
  portrait_poster_url: video.portraitPosterUrl ?? null,
});

export const fromPublicReleaseNoteVideo = (video: PublicReleaseNoteVideo): ModalVideo => ({
  landscapeUrl: video.landscape_url ?? null,
  landscapePosterUrl: video.landscape_poster_url ?? null,
  portraitUrl: video.portrait_url ?? null,
  portraitPosterUrl: video.portrait_poster_url ?? null,
});

/** A release note still image on the public wire: ModalStillImage with snake_case keys. */
export const PublicReleaseNoteImageSchema = z.object({
  landscape_url: z.string().nullable().optional(),
  portrait_url: z.string().nullable().optional(),
});
export type PublicReleaseNoteImage = z.infer<typeof PublicReleaseNoteImageSchema>;

export const toPublicReleaseNoteImage = (image: ModalStillImage): PublicReleaseNoteImage => ({
  landscape_url: image.landscapeUrl ?? null,
  portrait_url: image.portraitUrl ?? null,
});

export const fromPublicReleaseNoteImage = (image: PublicReleaseNoteImage): ModalStillImage => ({
  landscapeUrl: image.landscape_url ?? null,
  portraitUrl: image.portrait_url ?? null,
});

/** Each file of a release note video, by its path segment in GET /api/v1/whats-new/media/{id}/{asset}. */
export const RELEASE_NOTE_MEDIA_FIELDS = {
  landscape: 'landscapeUrl',
  'landscape-poster': 'landscapePosterUrl',
  portrait: 'portraitUrl',
  'portrait-poster': 'portraitPosterUrl',
} as const satisfies Record<string, ModalVideoField>;

/** Each file of a release note still image, by its path segment in the same media route. */
export const RELEASE_NOTE_IMAGE_MEDIA_FIELDS = {
  'image-landscape': 'landscapeUrl',
  'image-portrait': 'portraitUrl',
} as const satisfies Record<string, ModalStillImageField>;

export type ReleaseNoteMediaAsset =
  keyof typeof RELEASE_NOTE_MEDIA_FIELDS | keyof typeof RELEASE_NOTE_IMAGE_MEDIA_FIELDS;

/** The stored URL behind a media route asset, or null when the note has no such file. */
export function releaseNoteMediaUrl(
  note: { video?: ModalVideo | null; image?: ModalStillImage | null },
  asset: ReleaseNoteMediaAsset
): string | null {
  if (asset in RELEASE_NOTE_IMAGE_MEDIA_FIELDS) {
    const field = RELEASE_NOTE_IMAGE_MEDIA_FIELDS[asset as keyof typeof RELEASE_NOTE_IMAGE_MEDIA_FIELDS];
    return note.image?.[field] ?? null;
  }
  const field = RELEASE_NOTE_MEDIA_FIELDS[asset as keyof typeof RELEASE_NOTE_MEDIA_FIELDS];
  return note.video?.[field] ?? null;
}

/** Path of the media route, GET /api/v1/whats-new/media/{id}/{asset}, which signs an upload on request. */
export const RELEASE_NOTE_MEDIA_PATH = '/api/v1/whats-new/media';

/** Bucket prefix of an admin What's New video or poster; the media route only signs keys under it. */
export const MODAL_MEDIA_PREFIX = 'modals';

export const ReleaseNoteMediaParamsSchema = z.object({
  id: z.string().min(1),
  asset: z.enum([...Object.keys(RELEASE_NOTE_MEDIA_FIELDS), ...Object.keys(RELEASE_NOTE_IMAGE_MEDIA_FIELDS)] as [
    ReleaseNoteMediaAsset,
    ...ReleaseNoteMediaAsset[],
  ]),
});

/**
 * A release note as GET /api/v1/whats-new serves it. An allowlist: provenance (sourcePrs, deployedSha),
 * workflow state (status, editedAt) and storage fields never reach the public wire.
 */
export const PublicReleaseNoteSchema = z.object({
  id: z.string(),
  release_tag: z.string(),
  headline: z.string(),
  summary: z.string(),
  // ISO 8601; the instant the note became visible, and the list's sort key.
  published_at: z.string(),
  items: z.array(
    z.object({
      category: ReleaseNoteCategorySchema,
      text: z.string(),
      importance: z.number().int().min(1).max(3),
    })
  ),
  // Additive: absent when the note has no video. An uploaded file is served as a URL to
  // GET /api/v1/whats-new/media/{id}/{asset}, absolute when APP_URL is set and root-relative otherwise.
  // Hosts are not checked here; an upstream feed's videos are vetted on ingest
  // (server/releaseNotes/upstreamFeed.ts).
  video: PublicReleaseNoteVideoSchema.nullable().optional(),
  // Additive: absent when the note has no still image; served like the video, through the media route.
  image: PublicReleaseNoteImageSchema.nullable().optional(),
});
export type PublicReleaseNote = z.infer<typeof PublicReleaseNoteSchema>;
