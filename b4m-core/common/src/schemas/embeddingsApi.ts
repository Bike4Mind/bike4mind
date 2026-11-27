import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { ApiErrorSchema } from './chat';
import { ApiEmbeddingModelSchema } from './embedding';
import { EMBEDDING_PROVIDER_IDS } from '../embeddings/types';

/**
 * Public wire schema for `POST /api/v1/embeddings`.
 *
 * The request and response bodies mirror OpenAI's embeddings API field-for-field, so an OpenAI SDK
 * pointed at this base URL works unchanged. The error bodies do NOT - they carry the shared B4M
 * envelope (CONVENTIONS.md section 1), like every other public endpoint.
 *
 * Public-API rules apply: no `.catch()`, no top-level `.transform()`.
 */

/** OpenAI's per-request input ceiling; larger jobs page on the client. */
export const MAX_EMBEDDING_INPUTS = 2048;

/**
 * Token ceiling across all inputs of one request - OpenAI's per-request limit, so every provider's
 * request stays inside one Lambda invocation. (An OpenAI request past OPENAI_EFFECTIVE_TOKEN_LIMIT
 * is still split into sequential provider calls by OpenAIEmbeddingProvider.)
 */
export const MAX_EMBEDDING_REQUEST_TOKENS = 300_000;

/**
 * Ceiling on inputs x output width. A float serializes to ~21 JSON characters, so this keeps the
 * response near 4 MB - under the ~6 MB synchronous Lambda response limit (see infra/alarms.ts).
 * 128 inputs at 1536 dims, 192 at 1024, 64 at 3072.
 */
export const MAX_EMBEDDING_RESPONSE_VALUES = 196_608;

export const EMBEDDING_ENCODING_FORMATS = ['float', 'base64'] as const;

export const EmbeddingsRequestSchema = z.object({
  model: ApiEmbeddingModelSchema,
  input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_EMBEDDING_INPUTS)]),
  /**
   * Output width, constrained by the model dimensions returned by GET /api/v1/embedding-models.
   */
  dimensions: z.number().int().positive().optional(),
  /** Retrieval task hint; ignored by models without task-hint support. */
  input_type: z.enum(['query', 'document']).optional(),
  /** `base64` is the little-endian float32 buffer of each vector, as OpenAI encodes it. */
  encoding_format: z.enum(EMBEDDING_ENCODING_FORMATS).default('float'),
});

export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

export const EmbeddingObjectSchema = z.object({
  object: z.literal('embedding'),
  /** Position of the source text in `input`. */
  index: z.number().int(),
  embedding: z.union([z.array(z.number()), z.string()]),
});

export const EmbeddingsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(EmbeddingObjectSchema),
  model: z.string(),
  usage: z.object({
    /** Billed input tokens, using provider-reported usage when available. */
    prompt_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }),
});

export type EmbeddingsResponse = z.infer<typeof EmbeddingsResponseSchema>;

export const EMBEDDINGS_ERROR_CODES = [
  'insufficient_credits',
  'provider_not_configured',
  'provider_rejected',
] as const satisfies readonly ApiErrorCode[];

export const EmbeddingsErrorSchema = ApiErrorSchema.extend({
  errorCode: z.enum(EMBEDDINGS_ERROR_CODES).optional(),
});

export const EmbeddingDimensionsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), native: z.number().int().positive() }),
  z.object({ kind: z.literal('range'), native: z.number().int().positive(), min: z.number().int().positive() }),
  z.object({
    kind: z.literal('discrete'),
    native: z.number().int().positive(),
    values: z.array(z.number().int().positive()),
  }),
]);

export const EmbeddingModelSchema = z.object({
  id: ApiEmbeddingModelSchema,
  object: z.literal('embedding_model'),
  display_name: z.string(),
  provider: z.enum(EMBEDDING_PROVIDER_IDS),
  dimensions: EmbeddingDimensionsSchema,
  max_input_tokens: z.number().int().positive(),
  supports_input_type: z.boolean(),
  pricing: z.object({ usd_per_million_input_tokens: z.number().nonnegative() }).nullable(),
});
export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;
export const ListEmbeddingModelsResponseSchema = z.object({ models: z.array(EmbeddingModelSchema) });
export type ListEmbeddingModelsResponse = z.infer<typeof ListEmbeddingModelsResponseSchema>;
