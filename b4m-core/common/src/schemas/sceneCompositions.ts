import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { generatedAssetSaveSkippedReasonSchema } from '../generatedAsset';
import { GENERATION_OUTPUT_AVAILABILITIES } from '../generation/types';
import {
  SCENE_AUDIO_FITS,
  SCENE_DEFAULT_FADE_IN_SECONDS,
  SCENE_DEFAULT_FADE_OUT_SECONDS,
  SCENE_MAX_FADE_SECONDS,
  SCENE_MAX_INPUT_BYTES,
  SCENE_MAX_VIDEO_SECONDS,
  SCENE_TITLE_MAX_LENGTH,
} from '../scene';
import {
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  type GenerationJobErrorCode,
} from '../types/entities/GenerationJobTypes';
import { ApiErrorSchema } from './chat';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';

// Public wire shapes for /api/v1/scene-compositions, mirroring musicGenerations.ts. snake_case per CONVENTIONS.md;
// the domain request (SceneCompositionRequestSchema in scene/index.ts) stays camelCase.

export const SCENE_COMPOSITION_API_ERROR_CODES = [
  'invalid_request',
  'input_file_not_found',
  'unsupported_input',
  'limit_exceeded',
  'storage_limit_exceeded',
  'idempotency_key_reused',
  'invalid_idempotency_key',
  'not_cancellable',
] as const satisfies readonly ApiErrorCode[];
export type SceneCompositionApiErrorCode = (typeof SCENE_COMPOSITION_API_ERROR_CODES)[number];

// The classifiers a polled job can carry. Internal-only codes are folded into these by toPublicSceneJobErrorCode.
export const SCENE_JOB_PUBLIC_ERROR_CODES = [
  'unsupported_input',
  'provider_timeout',
  'provider_error',
  'output_too_large',
  'cancelled',
] as const satisfies readonly ApiErrorCode[];
export type SceneJobPublicErrorCode = (typeof SCENE_JOB_PUBLIC_ERROR_CODES)[number];

export function toPublicSceneJobErrorCode(code: GenerationJobErrorCode): SceneJobPublicErrorCode {
  switch (code) {
    case 'unsupported_input':
    case 'provider_timeout':
    case 'provider_error':
    case 'output_too_large':
    case 'cancelled':
      return code;
    // An input deleted or replaced between create and render.
    case 'input_image_not_found':
      return 'unsupported_input';
    // Provider-only outcomes a Scene (rendered by our own worker) never reaches, and internal failures.
    case 'content_blocked':
    case 'region_unavailable':
    case 'orphaned_submit':
    case 'enqueue_failed':
      return 'provider_error';
    // Refused before the render started, as for a cancel.
    case 'account_blocked':
      return 'cancelled';
    default: {
      const unreachable: never = code;
      throw new Error(`Unmapped generation job error code: ${String(unreachable)}`);
    }
  }
}

export const SceneCompositionErrorResponseSchema = ApiErrorSchema.extend({
  errorCode: z.enum(SCENE_COMPOSITION_API_ERROR_CODES).optional(),
});

const fileIdField = (what: string) =>
  z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .describe(`${what} One of your own files (GET /api/v1/files).`);

const fadeField = (which: string, fallback: number) =>
  z
    .number()
    .min(0)
    .max(SCENE_MAX_FADE_SECONDS)
    .optional()
    .describe(`Seconds of audio fade-${which}, 0 to ${SCENE_MAX_FADE_SECONDS}. Defaults to ${fallback}.`);

// No transforms or defaults: omitted fields take their defaults in createSceneCompositionJob.
export const CreateSceneCompositionBodySchema = z.strictObject({
  video_file_id: fileIdField(
    `The picture: a video file of at most ${SCENE_MAX_VIDEO_SECONDS} seconds. The Scene runs exactly as long as it, ` +
      'and its video stream is copied unchanged (any audio it has is replaced).'
  ),
  audio_file_id: fileIdField('The soundtrack: an audio file, e.g. a music generation output.'),
  audio: z
    .strictObject({
      fit: z
        .enum(SCENE_AUDIO_FITS)
        .optional()
        .describe(
          '`trim` (default): cut the audio where the video ends. `loop`: repeat the audio until the video ends.'
        ),
      fade_in_seconds: fadeField('in', SCENE_DEFAULT_FADE_IN_SECONDS),
      fade_out_seconds: fadeField('out', SCENE_DEFAULT_FADE_OUT_SECONDS),
    })
    .optional()
    .describe('How the soundtrack is fitted to the video. Omitted, it is trimmed with a short fade-out.'),
  cover_file_id: fileIdField('Optional cover art: an image file, embedded as the Scene thumbnail.').optional(),
  title: z
    .string()
    .min(1)
    .max(SCENE_TITLE_MAX_LENGTH)
    .optional()
    .describe('A name for the Scene; it also names the saved file.'),
});
export type CreateSceneCompositionBody = z.infer<typeof CreateSceneCompositionBodySchema>;

export const SceneCompositionSchema = z.object({
  id: z.string(),
  object: z.literal('scene_composition'),
  state: z.enum(GENERATION_JOB_STATES),
  video_file_id: z.string(),
  audio_file_id: z.string(),
  cover_file_id: z.string().nullable(),
  title: z.string().nullable(),
  audio: z.object({
    fit: z.enum(SCENE_AUDIO_FITS),
    fade_in_seconds: z.number(),
    fade_out_seconds: z.number(),
  }),
  source: z.enum(GENERATION_JOB_SOURCES),
  error: z.object({ code: z.enum(SCENE_JOB_PUBLIC_ERROR_CODES), message: z.string() }).nullable(),
  output: z
    .object({
      availability: z
        .enum(GENERATION_OUTPUT_AVAILABILITIES)
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
      duration_seconds: z.number().describe('The length of the Scene, which is the length of its video.'),
      files_skip_reason: generatedAssetSaveSkippedReasonSchema
        .nullable()
        .describe(
          'Why the Scene was stored outside Files, or null when it was saved there. `file_too_large`: it is over ' +
            'the per-file size limit. `storage_limit`: your storage quota has no room for it. `error`: the save ' +
            'failed. The Scene is still downloadable through url.'
        ),
      file_id: z.string().nullable().describe('The Files entry, or null when the Scene was stored outside Files.'),
    })
    .nullable(),
  credits: z
    .object({ reserved: z.number().nullable(), settled: z.number().nullable() })
    .describe('Composing a Scene is free: nothing is reserved, and `settled` is 0 once the job ends.'),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SceneComposition = z.infer<typeof SceneCompositionSchema>;

export const ListSceneCompositionsQuerySchema = PaginationQuerySchema.extend({
  state: z.enum(GENERATION_JOB_STATES).optional(),
  source: z.enum(GENERATION_JOB_SOURCES).optional(),
});
export const ListSceneCompositionsResponseSchema = paginatedResponseSchema(SceneCompositionSchema);

export const SceneCompositionIdParamSchema = z.object({ id: z.string().min(1) });

/** Published in the contract description so the limits are stated in one place. */
export const SCENE_COMPOSITION_LIMITS_DESCRIPTION =
  `The video may run at most ${SCENE_MAX_VIDEO_SECONDS} seconds, and the input files together may total at most ` +
  `${SCENE_MAX_INPUT_BYTES / (1024 * 1024)} MB. A Scene over your Files per-file size limit is still rendered, but ` +
  'is stored outside Files: its output has a null file_id and a files_skip_reason.';
