import { z } from 'zod';
import { IMongoDocument } from '.';
import { ICounter } from './CounterTypes';
import { VariantContent } from './AudienceVariantTypes';

export interface ModalImage {
  url: string;
  width?: number;
  height?: number;
}

export interface ModalVideo {
  landscapeUrl?: string | null;
  landscapePosterUrl?: string | null;
  portraitUrl?: string | null;
  portraitPosterUrl?: string | null;
}

export type ModalVideoField = keyof ModalVideo;

export interface ModalStillImage {
  landscapeUrl?: string | null;
  portraitUrl?: string | null;
}

export type ModalStillImageField = keyof ModalStillImage;

// Origins the app CSP allows in media-src and img-src on every deploy (apps/client/proxy.ts); keep in sync
const MODAL_MEDIA_HOST_SUFFIXES = ['.amazonaws.com', '.cloudfront.net'];
const MODAL_MEDIA_URL_MAX_LENGTH = 2048;

export const MODAL_MEDIA_URL_HINT = 'Upload the file, or paste an https URL on amazonaws.com or cloudfront.net';

/** What a deployment accepts beyond the static host list. */
export interface ModalMediaUrlPolicy {
  /** Exact origins (scheme, host, port), e.g. a self-host object store; an http origin allows http. */
  extraOrigins?: readonly string[];
  /** URLs accepted as-is, e.g. ones the admin upload itself produced. */
  allowedUrls?: ReadonlySet<string>;
}

export function isAllowedModalMediaUrl(url: string, policy: ModalMediaUrlPolicy = {}): boolean {
  if (url.length > MODAL_MEDIA_URL_MAX_LENGTH) return false;
  if (policy.allowedUrls?.has(url)) return true;
  try {
    const { protocol, hostname, origin, port } = new URL(url);
    if (policy.extraOrigins?.includes(origin)) return true;
    // The CSP source matches the default port only, so a non-default one would never load.
    return protocol === 'https:' && port === '' && MODAL_MEDIA_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Per-field problems with a modal video, empty when it is valid. Shared by the admin form and the API. */
export function getModalVideoErrors(
  video: ModalVideo | null | undefined,
  policy: ModalMediaUrlPolicy = {}
): Partial<Record<ModalVideoField, string>> {
  const errors: Partial<Record<ModalVideoField, string>> = {};
  if (!video) return errors;
  for (const field of ['landscapeUrl', 'landscapePosterUrl', 'portraitUrl', 'portraitPosterUrl'] as const) {
    const url = video[field];
    if (url && !isAllowedModalMediaUrl(url, policy)) errors[field] = MODAL_MEDIA_URL_HINT;
  }
  if (video.landscapePosterUrl && !video.landscapeUrl) {
    errors.landscapePosterUrl ??= 'A 16:9 poster needs its 16:9 video';
  }
  if (video.portraitPosterUrl && !video.portraitUrl) {
    errors.portraitPosterUrl ??= 'A 9:16 poster needs its 9:16 video';
  }
  return errors;
}

/** The video's fields with no host check, for reading stored or upstream data written under another policy. */
export const ModalVideoShapeSchema = z.object({
  landscapeUrl: z.string().nullable().optional(),
  landscapePosterUrl: z.string().nullable().optional(),
  portraitUrl: z.string().nullable().optional(),
  portraitPosterUrl: z.string().nullable().optional(),
});

/**
 * Product video for a modal slide. Landscape is the 16:9 cut shown on desktop, portrait the 9:16 cut
 * shown on mobile; the slider falls back to the other orientation when one is missing. The API passes
 * its deployment's extra origins; the bare `ModalVideoSchema` allows only the static host list.
 */
export function createModalVideoSchema(policy: ModalMediaUrlPolicy = {}) {
  return ModalVideoShapeSchema.superRefine((video, ctx) => {
    for (const [field, message] of Object.entries(getModalVideoErrors(video, policy))) {
      ctx.addIssue({ code: 'custom', path: [field], message });
    }
  });
}

export const ModalVideoSchema = createModalVideoSchema();

/** Per-field problems with a still image, empty when it is valid. */
export function getModalStillImageErrors(
  image: ModalStillImage | null | undefined,
  policy: ModalMediaUrlPolicy = {}
): Partial<Record<ModalStillImageField, string>> {
  const errors: Partial<Record<ModalStillImageField, string>> = {};
  if (!image) return errors;
  for (const field of ['landscapeUrl', 'portraitUrl'] as const) {
    const url = image[field];
    if (url && !isAllowedModalMediaUrl(url, policy)) errors[field] = MODAL_MEDIA_URL_HINT;
  }
  return errors;
}

/** The still image's fields with no host check, for reading stored or upstream data written under another policy. */
export const ModalStillImageShapeSchema = z.object({
  landscapeUrl: z.string().nullable().optional(),
  portraitUrl: z.string().nullable().optional(),
});

/** Still frame for a modal slide, in the same two orientations as the video. */
export function createModalStillImageSchema(policy: ModalMediaUrlPolicy = {}) {
  return ModalStillImageShapeSchema.superRefine((image, ctx) => {
    for (const [field, message] of Object.entries(getModalStillImageErrors(image, policy))) {
      ctx.addIssue({ code: 'custom', path: [field], message });
    }
  });
}

/**
 * Generation metadata for auto-generated modals (e.g., What's New).
 * Only populated for modals created by automated workflows.
 * Null/undefined for manually created modals and banners.
 */
export interface IGenerationMetadata {
  /** Date for daily batch generation (YYYY-MM-DD format) */
  generatedDate?: string;
  /** Array of release tags included in this modal */
  releases?: string[];
  /** Single release tag (backward compatibility) */
  releaseTag?: string;
  /** Correlation ID for tracing the generation request */
  correlationId: string;
  /** LLM model used for generation */
  modelUsed: string;
  /** Environment where the modal was generated */
  environment: 'dev' | 'production';
  /** Timestamp when the modal was generated */
  generatedAt: Date;
  /** Source modal ID from production (for fork-imported modals) */
  sourceModalId?: string;
  /** Origin of the modal - 'production' for imported, 'self' for locally generated */
  importedFrom?: 'production' | 'self';
  /** Content hash from production S3 at time of import (for edit detection during sync) */
  sourceContentHash?: string;
  /** Timestamp when the modal was last synced from production */
  lastSyncedAt?: Date;
}

export interface IModal {
  _id?: string | null;
  isBanner: boolean | false;
  title: string | null;
  subtitle: string | null;
  description: string | null; // markdown content
  tags: Array<string> | null;
  priority: number | 0;
  closeButton: boolean | true;
  agreeButton: boolean | false;
  enabled: boolean | true;
  startDate: string | null;
  endDate: string | null;
  numberOfAgrees: ICounter | null;
  numberOfViews: ICounter | null;
  imageUrl: string | null;
  images?: ModalImage[] | null;
  video?: ModalVideo | null;
  /** Release-note slides only (set by releaseNoteToModal); the Modal model does not persist it. */
  stillImage?: ModalStillImage | null;
  textMessage: string | null;
  /** Generation metadata for auto-generated modals (null for manual modals) */
  generationMetadata?: IGenerationMetadata | null;
  /**
   * Per-audience variant content. Keys are AudienceKey values ('internal' | 'customer').
   * Stripped at serve time - never appears in a serving-endpoint response body.
   * Absent on legacy / non-variant modals.
   */
  variants?: Partial<Record<string, VariantContent>> | null;
}

export interface IModalDocument extends IModal, IMongoDocument {}
