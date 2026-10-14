import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { QuestIdParamSchema, QuestPollResponseSchema } from '../../schemas/quest';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import { ListQuestFilesResponseSchema } from '../../schemas/publicFile';

const QUEST_SCOPES = [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE];

export const getQuestContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/quests/{id}',
  operationId: 'getQuest',
  summary: 'Get a quest',
  description:
    'Polls the outcome of a turn started by `POST /api/chat` or an async generation route. ' +
    '`status` `done` and `stopped` are terminal; `pending` and `running` are not. A finished turn ' +
    'that failed has `type: "error"` and, where classified, an `errorCode`; a `stopped` turn is also a ' +
    'failure even without `type: "error"`, and its `reply` is an explanation rather than an answer. A `404` covers a quest ' +
    'that does not exist, one whose session was deleted, and one the caller cannot see, so polling ' +
    'after deleting the session returns `404`. Safe (GET) requests are exempt from the per-day ' +
    'API-key quota: a poll consumes no daily slot, and only the per-minute burst limit applies.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: QUEST_SCOPES,
  pathParams: QuestIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The quest and its outcome so far.', schema: QuestPollResponseSchema },
    404: { description: 'No quest with that id is visible to the caller.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {},
  },
});

export const listQuestFilesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/quests/{id}/files',
  operationId: 'listQuestFiles',
  summary: 'List quest files',
  description:
    'Returns the files attached to one quest (one turn of a session): what was sent with the message and ' +
    'what the turn produced. Each carries a short-lived signed `download_url` once downloadable; re-read ' +
    'this endpoint rather than storing it. Not paginated: a quest holds a bounded set of files. A `404` ' +
    'covers a quest that does not exist and one in a session the caller cannot see.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: QUEST_SCOPES,
  pathParams: QuestIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: "The quest's files.",
      schema: ListQuestFilesResponseSchema,
      example: {
        files: [
          {
            id: '<fileId>',
            file_name: 'chart.png',
            mime_type: 'image/png',
            file_size: 482133,
            moderation_status: 'clean',
            download_url: 'https://<cdn>/<key>?Signature=...',
            download_url_expires_at: '2026-10-09T13:00:00.000Z',
            created_at: '2026-10-09T12:00:00.000Z',
          },
        ],
      },
    },
    403: {
      description: 'The API key holds none of `notebooks:read`, `ai:chat` or `ai:generate`.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'No quest with that id is visible to the caller.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
