import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { SessionCloneRequestSchema, SessionIdParamSchema, SessionResponseSchema } from '../../schemas/session';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

export const sessionCloneContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/sessions/{id}/clone',
  operationId: 'cloneSession',
  summary: 'Clone a session',
  description:
    'Clones a session (called a "notebook" in the product UI), including its messages and attachments. ' +
    'Omit `targetSurface` to inherit the source workspace, send `null` for the main notebook list, or ' +
    'send a surface id for another workspace. An API key needs `notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionIdParamSchema,
  request: SessionCloneRequestSchema,
  requestBodyRequired: false,
  validationErrorStatus: 400,
  emitsRateLimitHeaders: true,
  requestExample: {},
  responses: {
    200: { description: 'The cloned session.', schema: SessionResponseSchema },
    400: { description: 'The session id is missing or `targetSurface` is malformed.', schema: ApiErrorSchema },
    403: {
      description: 'The API key lacks `notebooks:write` or the caller is not allowed to clone sessions.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'No session with that id is visible to the caller.', schema: ApiErrorSchema },
    429: {
      description: 'The clone limit of 10 requests per minute per caller was exceeded.',
      schema: ApiErrorSchema,
      headers: { 'Retry-After': 'Seconds until the caller can retry.' },
    },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
