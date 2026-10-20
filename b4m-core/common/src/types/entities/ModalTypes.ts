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

// Origins the app CSP allows in media-src and img-src on every deploy (apps/client/proxy.ts); keep in sync
const MODAL_MEDIA_HOST_SUFFIXES = ['.amazonaws.com', '.cloudfront.net'];
const MODAL_MEDIA_URL_MAX_LENGTH = 2048;

export const MODAL_MEDIA_URL_HINT = 'Use an https URL on amazonaws.com or cloudfront.net';

export function isAllowedModalMediaUrl(url: string): boolean {
  if (url.length > MODAL_MEDIA_URL_MAX_LENGTH) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && MODAL_MEDIA_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Per-field problems with a modal video, empty when it is valid. Shared by the admin form and the API. */
export function getModalVideoErrors(video: ModalVideo | null | undefined): Partial<Record<ModalVideoField, string>> {
  const errors: Partial<Record<ModalVideoField, string>> = {};
  if (!video) return errors;
  for (const field of ['landscapeUrl', 'landscapePosterUrl', 'portraitUrl', 'portraitPosterUrl'] as const) {
    const url = video[field];
    if (url && !isAllowedModalMediaUrl(url)) errors[field] = MODAL_MEDIA_URL_HINT;
  }
  if (video.landscapePosterUrl && !video.landscapeUrl) {
    errors.landscapePosterUrl ??= 'A 16:9 poster needs its 16:9 video';
  }
  if (video.portraitPosterUrl && !video.portraitUrl) {
    errors.portraitPosterUrl ??= 'A 9:16 poster needs its 9:16 video';
  }
  return errors;
}

/**
 * Product video for a modal slide. Landscape is the 16:9 cut shown on desktop, portrait the 9:16 cut
 * shown on mobile; the slider falls back to the other orientation when one is missing.
 */
export const ModalVideoSchema = z
  .object({
    landscapeUrl: z.string().nullable().optional(),
    landscapePosterUrl: z.string().nullable().optional(),
    portraitUrl: z.string().nullable().optional(),
    portraitPosterUrl: z.string().nullable().optional(),
  })
  .superRefine((video, ctx) => {
    for (const [field, message] of Object.entries(getModalVideoErrors(video))) {
      ctx.addIssue({ code: 'custom', path: [field], message });
    }
  });

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
