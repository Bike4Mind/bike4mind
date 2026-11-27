import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { SessionIdParamSchema } from '../../schemas/session';
import { fabFileListResponseSchema } from '../../schemas/fabFileResponse';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/** Contract for GET /api/v1/sessions/{id}/files, served by apps/client/pages/api/v1/sessions/[id]/files.ts. */
export const listSessionFilesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/sessions/{id}/files',
  operationId: 'listSessionFiles',
  summary: "List a session's files",
  description:
    'Lists every file a session draws on: the knowledge files attached to it, the files attached to ' +
    'its turns, and the files its tools generated. Each entry carries a short-lived signed `fileUrl`. ' +
    'Works for a session you own or one shared with you. A session that does not exist, was deleted, ' +
    'or is not visible to you is `404`. An API key needs `notebooks:read` or `notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // Same pair as sessionGetContract: reading what a session holds is reading the session.
  scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: "The session's files.", schema: fabFileListResponseSchema },
    403: {
      description: 'The API key holds neither `notebooks:read` nor `notebooks:write`.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'No session with that id is visible to the caller.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
