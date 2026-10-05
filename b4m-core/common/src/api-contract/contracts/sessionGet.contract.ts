import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { SessionIdParamSchema, SessionResponseSchema } from '../../schemas/session';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Contract for GET /api/sessions/{id}. Shares its path with sessionUpdateContract and
 * sessionDeleteContract; apps/client/pages/api/sessions/[id]/index.ts serves all three.
 */
export const sessionGetContract = defineEndpoint({
  method: 'get',
  path: '/api/sessions/{id}',
  operationId: 'getSession',
  summary: 'Get a session',
  description:
    'Reads a session you own or that was shared with you (called a "notebook" in the product UI): ' +
    'its name, attached knowledge files, tags, and retrieval settings. Use it to confirm what a ' +
    '`PUT` on the same path stored. A session not visible to you, or one that was deleted, is ' +
    '`404`. An API key needs `notebooks:read` or `notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // WRITE_NOTEBOOKS is accepted too so a key that creates and updates sessions can read back
  // what it wrote without also being minted notebooks:read.
  scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The session.', schema: SessionResponseSchema },
    404: { description: 'No session with that id is visible to the caller.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {},
  },
});
