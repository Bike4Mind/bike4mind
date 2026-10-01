import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { CreateSessionRequestSchema, SessionResponseSchema } from '../../schemas/session';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

export const createSessionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/sessions',
  operationId: 'createSession',
  summary: 'Create a session',
  description:
    'Creates a session (called a "notebook" in the product UI). Pass the returned `id` as ' +
    '`session_id` to `POST /api/chat`, then poll `GET /api/v1/quests/{id}` for the reply. An API ' +
    'key needs `notebooks:write` for this call, so a chat round trip needs that scope as well as ' +
    '`ai:chat`. Unknown body fields are ignored. Naming a data lake with `dataLakeId` seeds the ' +
    "session with that lake's retrieval defaults.",
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // notebooks:write only, and ai:chat is deliberately not OR'd in: create can attach the session
  // to a project, which shares its files, so a chat-only key must not reach it.
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  request: CreateSessionRequestSchema,
  emitsRateLimitHeaders: true,
  requestExample: { name: 'Quarterly analysis' },
  responses: {
    200: { description: 'The created session.', schema: SessionResponseSchema },
    400: { description: 'The request could not be processed (for example a bad project id).', schema: ApiErrorSchema },
    403: {
      description: 'The key lacks `notebooks:write`, or is not bound to a requested data lake.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'A named data lake or project was not found.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { name: 'Quarterly analysis' },
  },
});
