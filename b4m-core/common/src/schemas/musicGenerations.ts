import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { GENERATION_OUTPUT_AVAILABILITIES } from '../generation/types';
import { MAX_MUSIC_LYRICS_CHARS, MUSIC_OUTPUT_FORMATS } from '../music/types';
import { MUSIC_VALIDATION_ERROR_CODES } from '../music/validate';
import {
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  type GenerationJobErrorCode,
} from '../types/entities/GenerationJobTypes';
import { ApiErrorSchema } from './chat';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';

// Public wire shapes for /api/v1/music-generations and /api/v1/music-models, mirroring videoGenerations.ts.
// snake_case per CONVENTIONS.md; the domain request (MusicGenerationRequestSchema) stays camelCase.

export const MUSIC_GENERATION_API_ERROR_CODES = [
  ...MUSIC_VALIDATION_ERROR_CODES,
  'invalid_request',
  'model_disabled',
  'model_unavailable',
  'insufficient_credits',
  'idempotency_key_reused',
  'invalid_idempotency_key',
] as const satisfies readonly ApiErrorCode[];
export type MusicGenerationApiErrorCode = (typeof MUSIC_GENERATION_API_ERROR_CODES)[number];

// The classifiers a polled job can carry. Internal-only codes are folded into these by toPublicMusicJobErrorCode.
export const MUSIC_JOB_PUBLIC_ERROR_CODES = [
  'content_blocked',
  'provider_timeout',
  'provider_error',
  'region_unavailable',
  'output_too_large',
  'cancelled',
] as const satisfies readonly ApiErrorCode[];
export type MusicJobPublicErrorCode = (typeof MUSIC_JOB_PUBLIC_ERROR_CODES)[number];

export function toPublicMusicJobErrorCode(code: GenerationJobErrorCode): MusicJobPublicErrorCode {
  switch (code) {
    case 'orphaned_submit':
    case 'enqueue_failed':
    // A music job takes no input image; the code is video-only.
    case 'input_image_not_found':
      return 'provider_error';
    case 'content_blocked':
    case 'provider_timeout':
    case 'provider_error':
    case 'region_unavailable':
    case 'output_too_large':
    case 'cancelled':
      return code;
    default: {
      const unreachable: never = code;
      throw new Error(`Unmapped generation job error code: ${String(unreachable)}`);
    }
  }
}

export const MusicGenerationErrorResponseSchema = ApiErrorSchema.extend({
  errorCode: z.enum(MUSIC_GENERATION_API_ERROR_CODES).optional(),
});

export const MUSIC_PROMPT_MAX_LENGTH = 4000;

// No transforms or defaults: omitted fields take the model's catalog defaults in createMusicJob.
export const CreateMusicGenerationBodySchema = z.strictObject({
  model: z.string().min(1).describe('A model id from GET /api/v1/music-models.'),
  prompt: z.string().min(1).max(MUSIC_PROMPT_MAX_LENGTH).describe('The style, mood and subject of the song.'),
  lyrics: z
    .string()
    .min(1)
    .max(MAX_MUSIC_LYRICS_CHARS)
    .optional()
    .describe("Lyrics to sing. Only for models whose `lyrics` is not null, within that model's limits."),
  instrumental: z
    .boolean()
    .optional()
    .describe('true for no vocals. Defaults to false, or to true for an instrumental-only model.'),
  duration_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Whole seconds. Defaults to the model's default; see the model's `duration` for how it is honoured."),
  organization_id: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'The organization to bill: one you belong to, or null for your personal credits. Omitted bills your ' +
        'home organization, or your personal credits if you have none.'
    ),
});
export type CreateMusicGenerationBody = z.infer<typeof CreateMusicGenerationBodySchema>;

export const MusicGenerationSchema = z.object({
  id: z.string(),
  object: z.literal('music_generation'),
  state: z.enum(GENERATION_JOB_STATES),
  model: z.string(),
  prompt: z.string(),
  lyrics: z.string().nullable().describe('The lyrics you sent, or null.'),
  instrumental: z.boolean(),
  duration_seconds: z.number().describe('The length requested (the model default when omitted).'),
  source: z.enum(GENERATION_JOB_SOURCES),
  error: z.object({ code: z.enum(MUSIC_JOB_PUBLIC_ERROR_CODES), message: z.string() }).nullable(),
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
      duration_seconds: z.number().describe('The length of the song produced, which can differ from the request.'),
      lyrics: z
        .string()
        .nullable()
        .describe(
          'What the model sang, as plain lines; null for instrumental output or when the provider does not report it.'
        ),
      file_id: z.string().nullable().describe('The Files entry, or null when the song was stored outside Files.'),
    })
    .nullable(),
  credits: z.object({ reserved: z.number().nullable(), settled: z.number().nullable() }),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MusicGeneration = z.infer<typeof MusicGenerationSchema>;

export const PublicMusicModelSchema = z.object({
  id: z.string(),
  object: z.literal('music_model'),
  display_name: z.string(),
  provider: z.string(),
  vocals: z.enum(['optional', 'never']).describe('`never`: instrumental only.'),
  lyrics: z
    .object({ max_chars: z.number(), max_line_chars: z.number().nullable() })
    .nullable()
    .describe('Limits on custom lyrics, or null when the model does not accept them.'),
  duration: z
    .discriminatedUnion('control', [
      z.object({
        control: z.enum(['exact', 'approximate']),
        min: z.number(),
        max: z.number(),
        default: z.number(),
      }),
      z.object({ control: z.literal('fixed'), seconds: z.number() }),
    ])
    .describe(
      '`exact`: the song has the requested length. `approximate`: the length is steered by the prompt, so the ' +
        'song may run shorter or longer. `fixed`: every song has this length; omit duration_seconds or repeat it.'
    ),
  output_formats: z.array(z.enum(MUSIC_OUTPUT_FORMATS)),
  typical_render_seconds: z.number().describe('A rough wall-clock estimate, to set expectations. Not billed on.'),
  pricing: z
    .object({ unit: z.enum(['per_song', 'per_second']), credits: z.number() })
    .describe('`per_song`: a flat price whatever the length. `per_second`: credits per second of output.'),
  preview: z.boolean().describe('Labelled preview by its provider: may change or be retired at short notice.'),
  deprecation_date: z.string().nullable(),
});
export type PublicMusicModel = z.infer<typeof PublicMusicModelSchema>;

export const ListMusicModelsResponseSchema = z.object({ models: z.array(PublicMusicModelSchema) });

export const ListMusicGenerationsQuerySchema = PaginationQuerySchema.extend({
  state: z.enum(GENERATION_JOB_STATES).optional(),
  source: z.enum(GENERATION_JOB_SOURCES).optional(),
});
export const ListMusicGenerationsResponseSchema = paginatedResponseSchema(MusicGenerationSchema);

export const MusicGenerationIdParamSchema = z.object({ id: z.string().min(1) });
