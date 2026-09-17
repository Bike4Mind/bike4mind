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
    'body and on the polled quest. A turn can FAIL after the ACK - reported on the polled quest as ' +
    '`type: "error"`, since the ACK was already sent. A terminal `status: "stopped"` (a missing ' +
    'session, a user-cancelled turn) is ALSO a failure even without `type: "error"` - it carries ' +
    'an explanatory string in `reply`/`replies` rather than an answer. `type` is the failure ' +
    'signal for every classified failure class (an abort, a provider timeout, a recovered stuck ' +
    'quest, credit exhaustion); `errorCode` is an optional refinement present only when the ' +
    'failure is a classified billing reason. `QUEST_ERROR_CODES` has two members, but only ' +
    '`insufficient_credits` reaches this poll path - a spend-cap-exceeded rejection is checked ' +
    'before a quest exists and surfaces as a synchronous 422 on `/api/embed/chat` instead. A ' +
    'caller must treat `type: "error"` OR a terminal `status: "stopped"` as failure even when ' +
    '`errorCode` is absent, and must not read `reply` as an answer without checking those first. ' +
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
        'the outcome arrives on `GET /api/quests/{id}` (see the `sendChatMessage200PollResult` ' +
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
          '`reply`, so a caller reading `reply` alone cannot tell a failure from an answer - check ' +
          '`type` first, and also treat a terminal `status: "stopped"` (a missing session, a ' +
          'user-cancelled turn) as failure even though it never sets `type`. `errorCode` is an ' +
          'optional refinement of `type: "error"`, present only for a classified billing failure; ' +
          'credit exhaustion arrives here as `insufficient_credits`, the same vocabulary the ' +
          'synchronous 422s on `/api/ai/music`, `/api/ai/sound-effects` and `/api/ai/tts` use. ' +
          '`QUEST_ERROR_CODES` publishes a second member, `spend_cap_exceeded`, but that rejection ' +
          'is caught before a quest exists and surfaces as a synchronous 422 on `/api/embed/chat` ' +
          'instead - it can never appear here. Most `type: "error"` turns - an abort, a provider ' +
          'timeout or overload, a recovered stuck quest - have NO `errorCode`; its absence does ' +
          'not mean success, only that the failure is unclassified. `type`/`errorCode` separate a ' +
          'recovered from a timeout with partial content keeps `type: "message"` even though it did ' +
          'not finish. The poll body carries further fields not modelled here, including `images`, ' +
          '`files`, `toolPayloads`, `promptMeta`, and the attachment report ' +
          '(`attachmentNotices`/`attachmentDelivery`) - only the outcome subset is modelled here.',
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
    422: { description: 'Request body failed schema validation.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { message: 'How do I reset my password?', toolMode: 'smart' },
  },
});
