import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  SimplifiedChatRequestSchema,
  ChatAckSchema,
  ChatQuestPollResultSchema,
  ApiErrorSchema,
} from '../../schemas/chat';

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
    '`wait: true` to block until the reply is ready and receive it inline. A tool that produced ' +
    'machine-readable state reports it under `toolPayloads` - an array of `{ type, payload }` ' +
    'entries in emission order, alongside (never instead of) the prose reply - on the `wait: true` ' +
    'body and on the polled quest. A turn can FAIL after the ACK - notably when the caller runs out ' +
    'of credits, which is reported on the quest rather than as a status, since the ACK was already ' +
    'sent: the polled quest is then `type: "error"` with `errorCode: "insufficient_credits"` (or ' +
    '`"spend_cap_exceeded"`) and the failure text in `reply`. Match on the classifier rather than ' +
    'reading `reply`, which carries that failure message in the same field a real answer uses. ' +
    'Authenticate with an API key (`b4m_live_`) or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  request: SimplifiedChatRequestSchema,
  requestExample: { message: 'How do I reset my password?', toolMode: 'smart' },
  // Served by baseApi, so the apiKeyRateLimit middleware sets the windowed
  // X-RateLimit-* headers on every API-key-authenticated response.
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description:
        'Message accepted - NOT a completed turn. The default (async) path returns this queued ACK; ' +
        'the outcome arrives on `GET /api/quests/{id}` (see the `sendChatMessagePollResult` ' +
        'schema), which reports a failed turn as `type: "error"` plus an `errorCode` classifier. ' +
        'With `wait: true` the body additionally carries the completed reply ' +
        '(`response`/`responses`), `toolPayloads`, `createdAt`, and `performance` timings - fields ' +
        'not modelled here yet; the synchronous response shape is a follow-up.',
      schema: ChatAckSchema,
      pollResult: {
        schema: ChatQuestPollResultSchema,
        description:
          'Outcome fields of the quest polled at `GET /api/quests/{id}` after this ACK. A finished ' +
          'turn that failed is `status: "done"` with `type: "error"` and the failure text in ' +
          '`reply`, so a caller reading `reply` alone cannot tell a failure from an answer - ' +
          '`errorCode` is the classifier to match on, and credit exhaustion is ' +
          '`insufficient_credits` (the balance is short) or `spend_cap_exceeded` (the admin-set ' +
          'ceiling is reached), the same vocabulary the synchronous 422s on `/api/ai/music`, ' +
          '`/api/ai/sound-effects` and `/api/ai/tts` use. The poll body carries further fields ' +
          '(`images`, `files`, `toolPayloads`, `promptMeta`); only the outcome subset is modelled here.',
        example: {
          id: '664f1c2b9a1e4d0012ab34cd',
          status: 'done',
          type: 'error',
          errorCode: 'insufficient_credits',
          reply: "You're out of credits. This request needs about 12 credits, but only 3 are available.",
        },
      },
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
