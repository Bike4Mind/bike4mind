import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { QuestIdParamSchema, QuestPollResponseSchema } from '../../schemas/quest';
import { ApiErrorSchema } from '../../schemas/chat';

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
  scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
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
