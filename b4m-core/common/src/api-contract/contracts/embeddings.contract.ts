import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  EmbeddingsErrorSchema,
  EmbeddingsRequestSchema,
  EmbeddingsResponseSchema,
  MAX_EMBEDDING_INPUTS,
  MAX_EMBEDDING_REQUEST_TOKENS,
  MAX_EMBEDDING_RESPONSE_VALUES,
} from '../../schemas/embeddingsApi';
import { ApiErrorSchema } from '../../schemas/chat';

const EXAMPLE_REQUEST = {
  model: 'text-embedding-3-small',
  input: ['The quick brown fox', 'jumps over the lazy dog'],
  dimensions: 1024,
};

/**
 * Contract for POST /api/v1/embeddings - raw embedding vectors for caller-supplied text.
 *
 * Exists so an integration that keeps its own vector index can embed through B4M (one key, one
 * credit pool) instead of holding a separate provider key.
 */
export const createEmbeddingsContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/embeddings',
  operationId: 'createEmbeddings',
  summary: 'Create embeddings',
  description:
    'Returns one embedding vector per input string. The request and success bodies follow the OpenAI ' +
    'embeddings API shape; error bodies use the standard B4M error envelope. `model` is any embedding ' +
    'model this deployment supports (OpenAI, Voyage AI, Amazon Bedrock, or a self-hosted Ollama model); ' +
    `\`input\` is a string or up to ${MAX_EMBEDDING_INPUTS} strings, at most ${MAX_EMBEDDING_REQUEST_TOKENS} ` +
    'tokens in total and each within the model context window. The input count is further capped so ' +
    `inputs x output width stays within ${MAX_EMBEDDING_RESPONSE_VALUES} values (128 inputs at 1536 ` +
    'dimensions) - page larger jobs across requests. `dimensions` shortens the vector on models ' +
    'that support it (OpenAI `text-embedding-3-*`, and Voyage models with several published widths). ' +
    'Billed in credits per input token from the per-model embedding rate, reserved before the provider ' +
    'call and refunded if it fails. Authenticate with an API key (`b4m_live_`) carrying `ai:generate`, ' +
    'or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: EmbeddingsRequestSchema,
  requestExample: EXAMPLE_REQUEST,
  responses: {
    200: {
      description: 'One embedding per input, in input order.',
      schema: EmbeddingsResponseSchema,
      example: {
        object: 'list',
        data: [
          { object: 'embedding', index: 0, embedding: [0.0023, -0.0093, 0.0158] },
          { object: 'embedding', index: 1, embedding: [-0.0112, 0.0047, 0.0201] },
        ],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 9, total_tokens: 9 },
      },
    },
    400: { description: 'The billing user or organization could not be resolved.', schema: ApiErrorSchema },
    401: {
      description:
        'Missing/invalid credentials, or the embedding provider refused the configured key ' +
        '(`errorCode: "provider_rejected"`).',
      schema: EmbeddingsErrorSchema,
    },
    422: {
      description:
        'Request body failed validation, an input exceeds the model context window, the request exceeds ' +
        'the token or response-size ceiling, the model cannot produce the requested `dimensions`, or the caller cannot ' +
        'afford the request - the last is tagged `errorCode: "insufficient_credits"`.',
      schema: EmbeddingsErrorSchema,
    },
    429: { description: 'Per-key rate limit exceeded.', schema: ApiErrorSchema },
    502: {
      description: 'The embedding provider failed; reserved credits are refunded.',
      schema: ApiErrorSchema,
    },
    503: {
      description:
        "This deployment has no credential for the requested model's provider " +
        '(`errorCode: "provider_not_configured"`).',
      schema: EmbeddingsErrorSchema,
    },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: EXAMPLE_REQUEST,
  },
});
