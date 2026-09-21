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
    'signal for the classified failure classes (an abort, a provider timeout, credit exhaustion); ' +
    '`errorCode` is an optional refinement present only when the failure is a classified billing ' +
    'reason. A recovered stuck quest is NOT in that list: one that still has renderable content ' +
    'resolves as a success by design. `QUEST_ERROR_CODES` has two members, but only ' +
    '`insufficient_credits` is raised as a quest errorCode by any current throw site on this ' +
    "endpoint - `spend_cap_exceeded` is thrown only by the embed chat route's pre-flight, which " +
    'fires outside the process try/catch that would classify it onto a quest. A ' +
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
        'Message accepted - NOT a completed turn. The default (async) path returns this queued ' +
        'ACK; the outcome arrives on `GET /api/quests/{id}` (see the `sendChatMessage200PollResult` ' +
        'schema). With `wait: true` the ' +
        'body additionally carries the completed reply (`response`/`responses`), `toolPayloads`, ' +
        '`createdAt`, and `performance` timings - fields not modelled here yet; the synchronous ' +
        'response shape is a follow-up. A turn that FAILS still resolves with `200`, never a 4xx, on ' +
        'both that `wait: true` body and the polled quest (`GET /api/quests/{id}`) - the prose ' +
        'explaining why lands in `reply`/`response` like any other answer, so the reply text alone ' +
        'cannot tell a failure from an answer. `type` is the field that can: both surfaces carry it ' +
        'unconditionally, so match on `type: "error"` first - it covers credit exhaustion, a ' +
        'provider timeout or overload, and an in-process aborted turn; a real answer carries the ' +
        'turn\'s actual completion type instead (`"message"` for an ordinary reply). Two related ' +
        'states do NOT set `type: "error"`: a user-cancelled turn resolves as `status: "stopped"` ' +
        'with `type` left at `"message"`, and a recovered stuck quest that still has renderable ' +
        'content resolves as a success (`status: "done"`, no error) by design, to avoid destroying ' +
        'content to report a failure. ' +
        '`errorCode` then names the failure reason, but only for the billing failures that have one - ' +
        '`"insufficient_credits"` today; it is absent on every other `type: "error"` turn, so never use ' +
        'its absence to infer success. On a real answer `errorCode` is absent from the `wait: true` ' +
        'body. Contrast the tts/music/soundEffects contracts, which reject synchronously with a 422 ' +
        'carrying the same `errorCode` vocabulary.',
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
          '`QUEST_ERROR_CODES` publishes a second member, `spend_cap_exceeded`, but no current ' +
          'throw site on this endpoint raises it as a quest errorCode: its only one, the embed ' +
          "chat route's pre-flight 422, fires outside the process try/catch that would classify " +
          'it onto the quest. Most `type: "error"` turns - an abort, a provider timeout or ' +
          'overload - have NO `errorCode`; its absence does not mean success, only that the ' +
          'failure is unclassified. A recovered stuck quest that still has renderable content is ' +
          'not a failure at all: it keeps `type: "message"` even though it did not finish, so a ' +
          'caller gets the content rather than an error. The poll body carries further fields not ' +
          'modelled here, including `images`, ' +
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
