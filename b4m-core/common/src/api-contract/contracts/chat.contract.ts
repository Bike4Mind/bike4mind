import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { SimplifiedChatRequestSchema, ChatAckSchema, ApiErrorSchema } from '../../schemas/chat';

/**
 * Contract for POST /api/chat. Single source of truth: the Next.js handler
 * (apps/client/pages/api/chat.ts) derives its auth + validation from this, and
 * the OpenAPI spec derives the operation from this. The same object could back a
 * Lambda handler unchanged (see server/cli/defineLambdaRoute.ts).
 */
export const chatContract = defineEndpoint({
  method: 'post',
  path: '/api/chat',
  operationId: 'sendChatMessage',
  summary: 'Send a chat message',
  description:
    'Sends a message to the AI and creates a quest to process it. By default (async) the call ' +
    'returns immediately with a quest id; poll `GET /api/quests/{id}` for the reply. Send ' +
    '`wait: true` to block until the reply is ready and receive it inline. Authenticate with an ' +
    'API key (`b4m_live_`) or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  request: SimplifiedChatRequestSchema,
  requestExample: { message: 'How do I reset my password?', toolMode: 'smart' },
  responses: {
    200: {
      description:
        'Message accepted. The default (async) path returns this queued ACK. With `wait: true` the ' +
        'body additionally carries the completed reply (`response`/`responses`), `createdAt`, and ' +
        '`performance` timings - fields not modelled here yet; the synchronous response shape is a follow-up.',
      schema: ChatAckSchema,
    },
    400: { description: 'No usable default chat model is configured and none was supplied.', schema: ApiErrorSchema },
    404: { description: 'No notebook/session exists to attach the message to.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { message: 'How do I reset my password?', toolMode: 'smart' },
  },
});
