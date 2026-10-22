import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  MAX_REFINE_CONTEXT_CHARS,
  MAX_REFINE_TEXT_CHARS,
  TextRefinementErrorSchema,
  TextRefinementRequestSchema,
  TextRefinementResponseSchema,
} from '../../schemas/textRefinement';
import { ApiErrorSchema } from '../../schemas/chat';

const EXAMPLE_REQUEST = {
  text: 'a dog on a beach',
  context: 'prompt for an image generator',
};

/**
 * Contract for POST /api/v1/text-refinements - rewrites a short description to be clearer and more
 * detailed. Shares its implementation with the legacy POST /api/ai/refineText (server/ai/refineTextRequest.ts).
 */
export const createTextRefinementContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/text-refinements',
  operationId: 'createTextRefinement',
  summary: 'Refine text',
  description:
    'Rewrites `text` to be more concise, clear and detailed while keeping its intent. `context` is optional ' +
    `background that steers the rewrite. \`text\` is at most ${MAX_REFINE_TEXT_CHARS} characters and ` +
    `\`context\` at most ${MAX_REFINE_CONTEXT_CHARS}. Output is capped at about 800 tokens, and identical ` +
    'requests are served from a cache for about five minutes. Not billed in credits. Authenticate with an ' +
    'API key (`b4m_live_`) carrying `ai:generate`, or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: TextRefinementRequestSchema,
  requestExample: EXAMPLE_REQUEST,
  responses: {
    200: {
      description: 'The refined text.',
      schema: TextRefinementResponseSchema,
      example: { text: 'A golden retriever running along a sunlit beach at sunset, waves breaking behind it.' },
    },
    429: { description: 'Per-key rate limit exceeded.', schema: ApiErrorSchema },
    500: {
      description: 'Unexpected server error (for example the refinement cache is unavailable).',
      schema: ApiErrorSchema,
    },
    502: { description: 'The model returned no refined text, or the call failed.', schema: ApiErrorSchema },
    503: {
      description: 'This deployment has no operations model configured (`errorCode: "provider_not_configured"`).',
      schema: TextRefinementErrorSchema,
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
