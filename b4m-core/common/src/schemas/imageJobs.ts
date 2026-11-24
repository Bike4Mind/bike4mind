import { z } from 'zod';
import { ModelIdSchema } from './modelId';
import { BillingOrganizationIdSchema } from './billingOrganization';
import { CompletionRunAttributionSchema } from './cliCompletions';
import type { ApiErrorCode } from '../apiErrorCodes';
import { GENERATION_OUTPUT_AVAILABILITIES } from '../generation/types';
import { IMAGE_INPUT_ROLES, IMAGE_MODES } from '../image/types';
import { IMAGE_VALIDATION_ERROR_CODES } from '../image/validate';
import {
  IMAGE_JOB_EDIT_REGIONS_PAYLOAD_MAX,
  IMAGE_JOB_INPUTS_MAX,
  IMAGE_JOB_PROMPT_MAX_CHARS,
} from '../image/jobRequest';
import { BflEditRegionSchema } from '../llm';
import { ImageOutputFormatSchema, OpenAIImageQualitySchema } from './openai';
import {
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  type GenerationJobErrorCode,
} from '../types/entities/GenerationJobTypes';
import { ApiErrorSchema } from './chat';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';

// Public wire shapes for /api/v1/image-jobs, mirroring musicGenerations.ts and videoGenerations.ts.
// snake_case per CONVENTIONS.md; the domain request (ImageJobRequestSchema) stays camelCase.

// Also the batch cap createImageJobs enforces (IMAGE_JOB_BATCH_MAX in @bike4mind/services/imageJobs).
export const IMAGE_JOB_COUNT_MAX = 4;

// The formats both providers' edit paths accept for a non-mask input image (createImageJobs refuses any other).
export const IMAGE_JOB_INPUT_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const IMAGE_JOB_API_ERROR_CODES = [
  ...IMAGE_VALIDATION_ERROR_CODES,
  'invalid_request',
  'model_unavailable',
  'input_image_not_found',
  'unsupported_input_image',
  'insufficient_credits',
  'idempotency_key_reused',
  'invalid_idempotency_key',
  'not_cancellable',
  'run_not_found',
  'run_budget_exhausted',
] as const satisfies readonly ApiErrorCode[];
export type ImageJobApiErrorCode = (typeof IMAGE_JOB_API_ERROR_CODES)[number];

// The classifiers a polled job can carry. Internal-only codes are folded into these by toPublicImageJobErrorCode.
export const IMAGE_JOB_PUBLIC_ERROR_CODES = [
  'content_blocked',
  'provider_timeout',
  'provider_error',
  'region_unavailable',
  'output_too_large',
  'input_image_not_found',
  'cancelled',
] as const satisfies readonly ApiErrorCode[];
export type ImageJobPublicErrorCode = (typeof IMAGE_JOB_PUBLIC_ERROR_CODES)[number];

export function toPublicImageJobErrorCode(code: GenerationJobErrorCode): ImageJobPublicErrorCode {
  switch (code) {
    case 'orphaned_submit':
    case 'enqueue_failed':
    // Compose-only: an image job's inputs are images, refused as input_image_not_found.
    case 'unsupported_input':
      return 'provider_error';
    case 'content_blocked':
    case 'provider_timeout':
    case 'provider_error':
    case 'region_unavailable':
    case 'output_too_large':
    case 'input_image_not_found':
    case 'cancelled':
      return code;
    // Refused before submit, so the provider never ran and the hold is returned, as for a cancel.
    case 'account_blocked':
      return 'cancelled';
    default: {
      const unreachable: never = code;
      throw new Error(`Unmapped generation job error code: ${String(unreachable)}`);
    }
  }
}

export const ImageJobErrorResponseSchema = ApiErrorSchema.extend({
  errorCode: z.enum(IMAGE_JOB_API_ERROR_CODES).optional(),
});

export const ImageJobInputBodySchema = z.strictObject({
  role: z
    .enum(IMAGE_INPUT_ROLES)
    .describe('`edit_source`: the image to edit. `mask`: where to edit it. `reference`: a style or subject anchor.'),
  file_id: z
    .string()
    .regex(/^[0-9a-f]{24}$/, 'file_id must be a file id')
    .describe('A file you uploaded (POST /api/v1/files) whose `moderation_status` is `clean`.'),
});

// No transforms or defaults: omitted fields take the model's defaults in createImageJobs.
export const CreateImageJobBodySchema = z.strictObject({
  model: ModelIdSchema.describe('A model id from GET /api/v1/image-models.'),
  mode: z
    .enum(IMAGE_MODES)
    .describe('`generate` renders from the prompt; `edit` changes an `edit_source` input. See the model `modes`.'),
  prompt: z.string().trim().min(1).max(IMAGE_JOB_PROMPT_MAX_CHARS).describe('Sent to the model as written.'),
  inputs: z
    .array(ImageJobInputBodySchema)
    .max(IMAGE_JOB_INPUTS_MAX)
    .optional()
    .describe("Input images, each used once. Which roles and how many a mode takes is the model's `input_roles`."),
  size: z.string().min(1).optional().describe("A size the model's `sizing` accepts, e.g. `1024x1024`."),
  aspect_ratio: z.string().min(1).optional().describe("A `W:H` ratio within the mode's `aspect_ratios`."),
  quality: OpenAIImageQualitySchema.optional().describe("One of the model's `qualities`."),
  output_format: ImageOutputFormatSchema.optional().describe("One of the mode's `output_formats`."),
  transparent_background: z
    .boolean()
    .optional()
    .describe('true for real alpha; only for models whose `transparent_background` is true.'),
  seed: z.number().int().nonnegative().optional().describe('Only for models whose `seed` is true.'),
  edit_regions: z
    .array(BflEditRegionSchema)
    .min(1)
    .max(IMAGE_JOB_EDIT_REGIONS_PAYLOAD_MAX)
    .optional()
    .describe('Edit mode only: regions to change, each with its own instruction, on models that take them.'),
  count: z
    .number()
    .int()
    .min(1)
    .max(IMAGE_JOB_COUNT_MAX)
    .optional()
    .describe(
      `Images to make, 1 to ${IMAGE_JOB_COUNT_MAX} (default 1). Each is its own job; they share a \`group_id\`.`
    ),
  organization_id: BillingOrganizationIdSchema,
  run: CompletionRunAttributionSchema.optional().describe(
    "The completion run these jobs are made for. Their whole estimated cost is claimed against that run's budget " +
      'before they are queued, and the request is refused with 422 `run_budget_exhausted` when it does not fit. ' +
      "The jobs bill the run's account."
  ),
});
export type CreateImageJobBody = z.infer<typeof CreateImageJobBodySchema>;

export const ImageJobSchema = z.object({
  id: z.string(),
  object: z.literal('image_generation'),
  state: z.enum(GENERATION_JOB_STATES),
  model: z.string(),
  mode: z.enum(IMAGE_MODES),
  prompt: z.string(),
  group_id: z.string().nullable().describe('Shared by the jobs one request created.'),
  source: z.enum(GENERATION_JOB_SOURCES),
  error: z.object({ code: z.enum(IMAGE_JOB_PUBLIC_ERROR_CODES), message: z.string() }).nullable(),
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
      file_id: z.string().nullable().describe('The Files entry, or null when the image was stored outside Files.'),
    })
    .nullable(),
  credits: z.object({ reserved: z.number().nullable(), settled: z.number().nullable() }),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PublicImageJob = z.infer<typeof ImageJobSchema>;

export const CreateImageJobResponseSchema = z.object({
  group_id: z.string(),
  data: z.array(ImageJobSchema).describe('One job per image, in request order.'),
});

export const ListImageJobsQuerySchema = PaginationQuerySchema.extend({
  state: z.enum(GENERATION_JOB_STATES).optional(),
  source: z.enum(GENERATION_JOB_SOURCES).optional(),
});
export const ListImageJobsResponseSchema = paginatedResponseSchema(ImageJobSchema);

export const ImageJobIdParamSchema = z.object({ id: z.string().min(1) });
