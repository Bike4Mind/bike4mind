import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  ListSessionQuestsQuerySchema,
  ListSessionQuestsResponseSchema,
  SessionIdParamSchema,
} from '../../schemas/session';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/** Contract for GET /api/v1/sessions/{id}/quests, served by apps/client/pages/api/v1/sessions/[id]/quests.ts. */
export const listSessionQuestsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/sessions/{id}/quests',
  operationId: 'listSessionQuests',
  summary: "List a session's quests",
  description:
    "Lists the turns (quests) of a session's conversation, oldest first: what was sent, the visible " +
    'reply, its status and the credits it cost. Works for a session you own or one shared with you. ' +
    'Cursor-paginated (see the pagination convention): pass `next_cursor` back as `cursor` until it ' +
    'is `null`. Re-read a non-terminal turn with `GET /api/v1/quests/{id}`. While a tool awaits ' +
    'approval the turn carries `pendingAction` (owner only). Deleted turns are not listed. A session that does not exist, was deleted, or is not visible ' +
    'to you is `404`. An API key needs `notebooks:read` or `notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // Same pair as sessionGetContract and listSessionsContract: reading a session's history is reading the session.
  scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionIdParamSchema,
  queryParams: ListSessionQuestsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of quests, oldest first.', schema: ListSessionQuestsResponseSchema },
    403: {
      description: 'The API key holds neither `notebooks:read` nor `notebooks:write`.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'No session with that id is visible to the caller.', schema: ApiErrorSchema },
    422: {
      description:
        '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A ' +
        'cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
