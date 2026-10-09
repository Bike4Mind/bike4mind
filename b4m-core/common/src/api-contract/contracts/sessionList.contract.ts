import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ListSessionsQuerySchema, ListSessionsResponseSchema } from '../../schemas/session';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * Contract for GET /api/v1/sessions. Shares its path with createSessionContract;
 * apps/client/pages/api/v1/sessions/index.ts serves both.
 */
export const listSessionsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/sessions',
  operationId: 'listSessions',
  summary: 'List sessions',
  description:
    'Lists the sessions you own (called "notebooks" in the product UI), newest first. Sessions shared ' +
    'with you are not included; read one of those by id with `GET /api/sessions/{id}`. Each item has ' +
    'the same shape `GET /api/sessions/{id}` returns. Cursor-paginated (see the pagination convention): ' +
    'pass `next_cursor` back as `cursor` until it is `null`. Changing `search`, `surface` or `origin` ' +
    'starts a new listing, so drop the cursor when you do. An API key needs `notebooks:read` or ' +
    '`notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // Same pair as sessionGetContract, so a key that creates sessions can also find them again.
  scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS],
  queryParams: ListSessionsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of sessions, newest first by `id`.', schema: ListSessionsResponseSchema },
    403: {
      description: 'The API key holds neither `notebooks:read` nor `notebooks:write`.',
      schema: ScopeForbiddenErrorSchema,
    },
    422: {
      description:
        '`limit` is out of range, a filter is malformed, or `cursor` is malformed or was issued by a ' +
        'different endpoint. A cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
