import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts
// (the barrel drags in @bike4mind/hearth, unbuilt in the CI openapi job).
import { ApiErrorSchema } from '../../schemas/chat';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ListModelsResponseSchema } from '../../schemas/publicModel';

/**
 * Contract for GET /api/v1/models. Not an alias of the unversioned `GET /api/models`: that
 * route keeps serving the full internal `ModelInfo` to the SPA and CLI, while this one
 * publishes the narrower `PublicModel` projection. Both read the same per-caller list
 * (server/utils/callerModelList.ts), so they can never disagree on which models exist.
 */
export const listModelsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/models',
  operationId: 'listModels',
  summary: 'List models',
  description:
    'Lists the models the caller can use right now - the platform catalog filtered to the providers ' +
    "the caller has a key for, their own or the platform's. Use it to choose a `model` by capability " +
    'before calling a generation endpoint: `context_window` and `max_output_tokens` for text models, and ' +
    'for image models the `image` block, which lists the accepted `size` values (or the rule they must ' +
    'meet) and whether `background`, `seed`, `quality`, `n` and reference images are honoured. To pick the ' +
    'cheapest text model, compare `credits_per_1m_tokens` - the rate a call is billed at. The list ' +
    'is cached for up to a minute per caller. Cursor-paginated (see the pagination convention): pass ' +
    '`next_cursor` back as `cursor` until it is `null`. Sorted by `id` ascending. ' +
    'Authenticate with an API key (`b4m_live_`) ' +
    'carrying `ai:chat` or `ai:generate`, or a JWT.',
  tags: ['Models'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'One page of models, ordered by `id`.',
      schema: ListModelsResponseSchema,
      example: {
        data: [
          {
            id: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
            type: 'text',
            backend: 'anthropic',
            description: null,
            context_window: 1_000_000,
            max_output_tokens: 128_000,
            supports_streaming: true,
            supports_thinking: true,
            reasons_within_output_budget: true,
            reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
            supports_tools: true,
            supports_tool_search: true,
            supports_tool_changes: false,
            supports_assistant_prefill: false,
            supports_vision: true,
            deprecation_date: null,
            replaced_by: null,
            image: null,
            credits_per_1m_tokens: { input: 4000, output: 20000, cached_input: 400 },
          },
          {
            id: 'gpt-image-1',
            name: 'GPT Image 1',
            type: 'image',
            backend: 'openai',
            description: null,
            context_window: 0,
            max_output_tokens: 0,
            supports_streaming: false,
            supports_thinking: false,
            reasons_within_output_budget: false,
            reasoning_efforts: [],
            supports_tools: false,
            supports_tool_search: false,
            supports_tool_changes: false,
            supports_assistant_prefill: true,
            supports_vision: false,
            deprecation_date: null,
            replaced_by: null,
            credits_per_1m_tokens: null,
            image: {
              sizing: {
                kind: 'presets',
                presets: ['1024x1024', '1024x1536', '1536x1024'],
                default_size: '1024x1024',
              },
              supports: {
                transparent_background: true,
                seed: false,
                qualities: ['low', 'medium', 'high', 'auto'],
                max_images: 10,
                max_reference_images: 15,
                edit: true,
                requires_input_image: false,
              },
            },
          },
        ],
        next_cursor: null,
      },
    },
    422: {
      description:
        '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A ' +
        'cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
