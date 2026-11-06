import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { SessionSemanticSearchRequestSchema, SessionSemanticSearchResponseSchema } from '../../schemas/session';
import { ApiErrorSchema, InsufficientCreditsErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

const EXAMPLE_REQUEST = { query: 'quarterly budget review', topK: 10 };

/** Contract for POST /api/v1/sessions/semantic-search, served by apps/client/pages/api/v1/sessions/semantic-search.ts. */
export const searchSessionsContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/sessions/semantic-search',
  operationId: 'searchSessions',
  summary: 'Search your sessions by meaning',
  description:
    'Finds the sessions of yours whose conversations match a query. By default it first keeps the ' +
    'messages that contain the query terms (after spelling correction and synonym expansion), then ranks ' +
    'them by embedding similarity, so a result is both on topic and close in meaning. Set `hybridMode` ' +
    'to `false` to rank every message by similarity alone, and `useReRanking` to have a language model ' +
    'verify the best candidates. Only sessions you own are searched. Messages without a stored embedding ' +
    'are embedded on the fly up to a cap; `partial` says the cap was hit. The query expansion, ' +
    'embeddings and re-rank run on platform keys and are billed in credits to the caller, reserved before ' +
    'each call and refunded if it fails. An API key needs `notebooks:read` or `notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS],
  request: SessionSemanticSearchRequestSchema,
  requestExample: EXAMPLE_REQUEST,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'Matching sessions, best first.', schema: SessionSemanticSearchResponseSchema },
    400: {
      description:
        'The billing organization could not be resolved, or the deployment has no credential for the ' +
        'configured embedding provider.',
      schema: ApiErrorSchema,
    },
    403: {
      description:
        'The API key holds neither `notebooks:read` nor `notebooks:write`, or AI features are disabled ' +
        'on the account.',
      schema: ScopeForbiddenErrorSchema,
    },
    422: {
      description:
        'The body failed validation (`query` missing or blank, a number out of range), or the caller ' +
        'cannot afford the request - the last is tagged `errorCode: "insufficient_credits"`.',
      schema: InsufficientCreditsErrorSchema,
    },
    429: {
      description: 'Per-user rate limit exceeded, or the account has too many completions in flight.',
      schema: ApiErrorSchema,
    },
    500: { description: 'The search failed or the embedding model is not configured.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: EXAMPLE_REQUEST },
});
