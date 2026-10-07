import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { SessionIdParamSchema, SessionDeleteResponseSchema } from '../../schemas/session';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Contract for DELETE /api/sessions/{id}. Shares its path with sessionGetContract and
 * sessionUpdateContract; apps/client/pages/api/sessions/[id]/index.ts serves all three.
 */
export const sessionDeleteContract = defineEndpoint({
  method: 'delete',
  path: '/api/sessions/{id}',
  operationId: 'deleteSession',
  summary: 'Delete a session',
  description:
    'Deletes one of your sessions (called a "notebook" in the product UI). This cannot be undone ' +
    'through the API. Files you uploaded into the session are deleted with it; files other people ' +
    'uploaded into it are kept, and every access grant this session gave out on a file is revoked. ' +
    'A session you do not own, or one already deleted, is `404`. A `409` means a concurrent change ' +
    'touched one of those files mid-delete; nothing was deleted, so retry. An API key needs ' +
    '`notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // Same single scope as sessionUpdateContract, for the same reason: narrow-purpose keys must not
  // gain a destructive verb on sessions.
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The session was deleted.', schema: SessionDeleteResponseSchema },
    404: { description: 'No session with that id is visible to the caller.', schema: ApiErrorSchema },
    409: {
      description: 'A concurrent change touched a file this session shares; nothing was deleted. Retry.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
  },
});
