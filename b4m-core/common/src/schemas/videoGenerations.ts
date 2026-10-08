import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { ASPECT_RATIOS, RESOLUTION_TIERS, VIDEO_MODES } from '../video/types';
import { VIDEO_VALIDATION_ERROR_CODES } from '../video/validate';
import {
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  type GenerationJobErrorCode,
} from '../types/entities/GenerationJobTypes';
import { ApiErrorSchema } from './chat';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';

// Public wire shapes for /api/v1/video-generations and /api/v1/video-models. snake_case per CONVENTIONS.md;
// the domain request (VideoGenerationRequestSchema) stays camelCase and the handler maps between them.

export const VIDEO_GENERATION_API_ERROR_CODES = [
  ...VIDEO_VALIDATION_ERROR_CODES,
  'invalid_request',
  'model_disabled',
  'model_unavailable',
  'insufficient_credits',
  'input_image_not_found',
  'idempotency_key_reused',
  'invalid_idempotency_key',
] as const satisfies readonly ApiErrorCode[];

// The classifiers a polled job can carry. Internal-only codes are folded into these by toPublicVideoJobErrorCode.
export const VIDEO_JOB_PUBLIC_ERROR_CODES = [
  'content_blocked',
  'provider_timeout',
  'provider_error',
  'region_unavailable',
  'output_too_large',
  'input_image_not_found',
  'cancelled',
] as const satisfies readonly ApiErrorCode[];
export type VideoJobPublicErrorCode = (typeof VIDEO_JOB_PUBLIC_ERROR_CODES)[number];

export function toPublicVideoJobErrorCode(code: GenerationJobErrorCode): VideoJobPublicErrorCode {
  switch (code) {
    case 'orphaned_submit':
    case 'enqueue_failed':
      return 'provider_error';
    case 'content_blocked':
    case 'provider_timeout':
    case 'provider_error':
    case 'region_unavailable':
    case 'output_too_large':
    case 'input_image_not_found':
    case 'cancelled':
      return code;
    default: {
      const unreachable: never = code;
      throw new Error(`Unmapped generation job error code: ${String(unreachable)}`);
    }
  }
}

export const VideoGenerationErrorResponseSchema = ApiErrorSchema.extend({
  errorCode: z.enum(VIDEO_GENERATION_API_ERROR_CODES).optional(),
});

export const VIDEO_PROMPT_MAX_LENGTH = 4000;

// No transforms or defaults: omitted fields take the model's catalog defaults in the handler.
// Strict so a caller migrating from the removed Sora body (e.g. `callbackUrl`, webhooks no longer exist) gets a 422
// naming the key instead of a 202 and a webhook that never arrives.
export const CreateVideoGenerationBodySchema = z.strictObject({
  model: z.string().min(1).describe('A model id from GET /api/v1/video-models.'),
  prompt: z.string().min(1).max(VIDEO_PROMPT_MAX_LENGTH),
  mode: z
    .enum(VIDEO_MODES)
    .optional()
    .describe('Defaults to image_to_video when input_image_file_id is set, else text_to_video.'),
  duration_seconds: z.number().positive().optional().describe("Defaults to the model's default duration."),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
  resolution: z.enum(RESOLUTION_TIERS).optional(),
  input_image_file_id: z.string().min(1).optional().describe('An image file you own, for image_to_video.'),
  audio: z.boolean().optional(),
});
export type CreateVideoGenerationBody = z.infer<typeof CreateVideoGenerationBodySchema>;

// Whether a succeeded job's output can be downloaded now, later, or never: the one field that tells a client
// whether to keep re-reading the job for a url. Must stay in sync with signOutputUrl in apps/client.
export const VIDEO_OUTPUT_AVAILABILITIES = ['ready', 'pending_scan', 'unavailable'] as const;
export type VideoOutputAvailability = (typeof VIDEO_OUTPUT_AVAILABILITIES)[number];

export const VideoGenerationSchema = z.object({
  id: z.string(),
  object: z.literal('video_generation'),
  state: z.enum(GENERATION_JOB_STATES),
  model: z.string(),
  mode: z.enum(VIDEO_MODES),
  prompt: z.string(),
  duration_seconds: z.number(),
  aspect_ratio: z.enum(ASPECT_RATIOS),
  resolution: z.enum(RESOLUTION_TIERS),
  source: z.enum(GENERATION_JOB_SOURCES),
  progress: z.number().min(0).max(1).nullable(),
  error: z.object({ code: z.enum(VIDEO_JOB_PUBLIC_ERROR_CODES), message: z.string() }).nullable(),
  output: z
    .object({
      availability: z
        .enum(VIDEO_OUTPUT_AVAILABILITIES)
        .describe(
          '`ready`: url is set. `pending_scan`: the saved file is still being scanned; re-fetch the job until ' +
            'it changes (self-hosted installs can stay here for up to ~30 minutes). `unavailable`: the file ' +
            'was blocked by the scan or deleted and url will never be set; stop polling.'
        ),
      url: z
        .string()
        .nullable()
        .describe(
          'Signed download URL, valid until expires_at; re-fetch the job for a fresh one. Set only when ' +
            'availability is `ready`, otherwise null.'
        ),
      expires_at: z.string().nullable().describe('ISO 8601. When url stops working; null whenever url is.'),
      content_type: z.string(),
      duration_seconds: z.number(),
      file_id: z.string().nullable().describe('The Files entry, or null when the clip was stored outside Files.'),
    })
    .nullable(),
  credits: z.object({ reserved: z.number().nullable(), settled: z.number().nullable() }),
  created_at: z.string(),
  updated_at: z.string(),
});
export type VideoGeneration = z.infer<typeof VideoGenerationSchema>;

export const VideoModelSchema = z.object({
  id: z.string(),
  object: z.literal('video_model'),
  display_name: z.string(),
  provider: z.string(),
  modes: z.array(z.enum(VIDEO_MODES)),
  duration: z.union([
    z.object({ kind: z.literal('range'), min: z.number(), max: z.number(), step: z.number() }),
    z.object({ kind: z.literal('discrete'), values: z.array(z.number()) }),
  ]),
  aspect_ratios: z.array(z.enum(ASPECT_RATIOS)),
  resolutions: z.array(z.enum(RESOLUTION_TIERS)),
  defaults: z.object({
    duration_seconds: z.number(),
    aspect_ratio: z.enum(ASPECT_RATIOS),
    resolution: z.enum(RESOLUTION_TIERS),
  }),
  audio: z.enum(['always', 'optional', 'none']),
  credits_per_second: z
    .record(z.string(), z.number())
    .nullable()
    .describe('Credits per second of output by resolution; null for per-clip priced models.'),
  deprecation_date: z.string().nullable(),
});
export type VideoModel = z.infer<typeof VideoModelSchema>;

export const ListVideoModelsResponseSchema = z.object({ models: z.array(VideoModelSchema) });

export const ListVideoGenerationsQuerySchema = PaginationQuerySchema.extend({
  state: z.enum(GENERATION_JOB_STATES).optional(),
  source: z.enum(GENERATION_JOB_SOURCES).optional(),
});
export const ListVideoGenerationsResponseSchema = paginatedResponseSchema(VideoGenerationSchema);

export const VideoGenerationIdParamSchema = z.object({ id: z.string().min(1) });
