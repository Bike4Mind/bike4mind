import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  SessionMessageDeleteResponseSchema,
  SessionMessageParamSchema,
  SessionMessageUpdateRequestSchema,
} from '../../schemas/session';
import { chatMessageResponseSchema, updateChatMessageResponseSchema } from '../../schemas/chatMessage';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

const PATH = '/api/v1/sessions/{id}/messages/{messageId}';
const READ_SCOPES = [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS];
const NOT_VISIBLE = 'No session or message with those ids is visible to the caller.';
const SHARED_NOTE =
  'A message of a session shared with you reads without `pendingAction` or the owner-only fields of `promptMeta`.';

/**
 * Contracts for GET/PUT/DELETE /api/v1/sessions/{id}/messages/{messageId}. A "message" is one turn
 * of the conversation (a quest). All three are served by
 * apps/client/pages/api/v1/sessions/[id]/messages/[messageId].ts.
 */
export const getSessionMessageContract = defineEndpoint({
  method: 'get',
  path: PATH,
  operationId: 'getSessionMessage',
  summary: 'Get a message of a session',
  description:
    'Reads one turn of a session conversation: the prompt, the reply, attachments, status and cost. ' +
    `Works for a session you own or one shared with you. ${SHARED_NOTE} A session or message that does ` +
    'not exist or was deleted is `404`. An API key needs `notebooks:read` or `notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: SessionMessageParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The message.', schema: chatMessageResponseSchema },
    403: {
      description:
        'The API key holds neither `notebooks:read` nor `notebooks:write`, or the caller has no access to the session.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: NOT_VISIBLE, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});

export const updateSessionMessageContract = defineEndpoint({
  method: 'put',
  path: PATH,
  operationId: 'updateSessionMessage',
  summary: 'Update a message of a session',
  description:
    'Edits one turn of a session conversation: replaces `reply` or `replies`, pins it, or records which ' +
    'suggested choice was picked. Only those fields are writable; any other key is ignored. Needs write ' +
    'access to the session: the owner, or a user or group it was shared with at the update level. ' +
    `${SHARED_NOTE} A session or message that does not exist or was deleted is \`404\`. An API key needs ` +
    '`notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // WRITE_NOTEBOOKS only, as sessionUpdateContract: narrow-purpose keys must not gain a rewrite verb.
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionMessageParamSchema,
  request: SessionMessageUpdateRequestSchema,
  requestExample: { pinned: true },
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The updated message.', schema: updateChatMessageResponseSchema },
    403: {
      description: 'The API key lacks `notebooks:write`, or the caller may not update the session (read-only share).',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: NOT_VISIBLE, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { pinned: true } },
});

export const deleteSessionMessageContract = defineEndpoint({
  method: 'delete',
  path: PATH,
  operationId: 'deleteSessionMessage',
  summary: 'Delete a message of a session',
  description:
    'Deletes one turn of a session conversation. It disappears from the session history; this cannot be ' +
    'undone through the API. Only the owner of the session may delete. A session you do not own, or a ' +
    'message that does not exist or was already deleted, is `404`. An API key needs `notebooks:write`.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionMessageParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The message was deleted.', schema: SessionMessageDeleteResponseSchema },
    403: { description: 'The API key lacks `notebooks:write`.', schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_VISIBLE, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
