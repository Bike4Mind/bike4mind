import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { SessionTurnRequestSchema, SessionTurnStreamEventSchema } from '../../schemas/sessionTurns';
import {
  ApiErrorSchema,
  CompletionsBadRequestErrorSchema,
  CompletionsUnprocessableErrorSchema,
  ModelPolicyForbiddenErrorSchema,
  SPEND_FROZEN_FORBIDDEN_NOTE,
} from '../../schemas/chat';
import { EXAMPLE_RESOURCE_ID } from '../exampleIds';

/**
 * Contract for POST /api/v1/turns - add a turn to an existing session and stream it back. Served
 * by the always-on ChatCompletion Fargate service as an SSE stream
 * (apps/client/server/chatCompletion/external/turnsRoute.ts), like createCompletion: the handler
 * derives its request schema and auth from this contract via resolveContractAuth and owns the
 * stream itself. The turn runs through the same pipeline as a web composer send, so web and other
 * devices watching the session see it live over the websocket too.
 *
 * The path is a top-level `/api/v1/turns` rather than `/api/v1/sessions/{id}/turns` because
 * CloudFront routes to the Fargate origin by path prefix only (infra/chatCompletion.ts), and every
 * other `/api/v1/sessions/*` route is served by Next.
 */
export const createSessionTurnContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/turns',
  operationId: 'createSessionTurn',
  summary: 'Add a turn to a session',
  description:
    'Adds a user message to an existing session (called a "notebook" in the product UI) and runs the ' +
    'assistant reply through the same pipeline as the web app, so the turn appears in the session and ' +
    'every other client watching it sees it live. A successful request is answered with an SSE stream ' +
    '(`text/event-stream`): a `meta` event carrying `requestId`, a `turn` event with the new `quest_id` ' +
    'and `session_id`, then `delta` events (`{ quest_id, slot, text }`) that each APPEND `text` to reply ' +
    'slot `slot`, and `replace` events (`{ quest_id, slot, text }`) that REPLACE a slot whole when the ' +
    'server reset or rewrote it (a retry, a rapid-reply handoff). Thinking models stream their reasoning ' +
    'in an earlier slot than the answer. One `settled` event (`{ quest_id, status, failed, credits_used, ' +
    'error_code }`) follows the last slot event, then `data: [DONE]`. `status` is `done` or `stopped`; ' +
    'when `failed` is true the slots hold an explanation rather than an answer, and `error_code` names ' +
    'the cause when it is a known one.\n\n' +
    'DISCONNECTS. Closing the stream detaches from the turn; it does not stop it. The turn runs to the end ' +
    "and is saved to the session, and an API key's concurrent-request slot stays held until the turn " +
    'finishes. Stop a turn with `POST /api/sessions/{id}/chat/stop-reply`.\n\n' +
    'ERRORS. Everything checked before the turn starts fails with a JSON error body and a real HTTP ' +
    'status, before any stream opens: a bad credential `401`; a key without `ai:chat` `403` (with ' +
    '`required_scopes`); a suspended account, paused spending or an organization the caller cannot bill ' +
    '`403` with an `errorCode`; a `model` that does not exist, is disabled or cannot run a chat ' +
    'completion `400`; a `session_id` that does not exist or that the caller cannot write to `404` (the ' +
    'two are indistinguishable on purpose); a body that fails schema validation `422`; too many requests, ' +
    'or the free-tier daily allowance used up, `429` with `Retry-After`. Once the turn exists the stream ' +
    'opens and the status stays `200`: a turn the account cannot pay for (`error_code: ' +
    '"insufficient_credits"`) or a model its plan or organization does not allow is reported by its ' +
    '`settled` event with `failed: true`, like any other failed turn, and an `error` event is sent only ' +
    'when the server could not follow the turn to its end.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT],
  request: SessionTurnRequestSchema,
  requestExample: {
    session_id: EXAMPLE_RESOURCE_ID,
    message: 'Summarize the attached report.',
    model: 'claude-opus-4-8',
  },
  streaming: true,
  responses: {
    200: {
      description: 'SSE stream of turn events (see the SessionTurnStreamEvent shape).',
      contentType: 'text/event-stream',
      schema: SessionTurnStreamEventSchema,
      example: { type: 'delta', quest_id: EXAMPLE_RESOURCE_ID, slot: 0, text: 'The report covers' },
    },
    400: {
      description:
        'A `model` that does not exist, is disabled or cannot run a chat completion, or an otherwise invalid request.',
      schema: CompletionsBadRequestErrorSchema,
    },
    403: {
      description:
        'The API key does not hold `ai:chat`, the account is suspended (`errorCode: "account_suspended"`), ' +
        'AI access is turned off for the account, the organization policy does not allow the model for an ' +
        'API key (`errorCode: "org_model_not_allowed"`; a signed-in caller gets the refusal as a failed ' +
        'turn in the stream), or the caller named an `organization_id` it cannot ' +
        `bill (\`errorCode: "billing_organization_mismatch"\` for an organization-billed key). ${SPEND_FROZEN_FORBIDDEN_NOTE}`,
      schema: ModelPolicyForbiddenErrorSchema,
    },
    404: {
      description: 'No session with that id exists, or the caller cannot write to it.',
      schema: ApiErrorSchema,
    },
    422: {
      description: 'The body failed schema validation.',
      schema: CompletionsUnprocessableErrorSchema,
    },
    429: {
      description:
        'Rate limit exceeded, or the free-tier daily allowance is used up (`errorCode: "daily_free_limit_reached"`).',
      schema: ApiErrorSchema,
      headers: { 'Retry-After': 'Seconds to wait before retrying.' },
    },
    500: { description: 'Internal error before the stream opened.', schema: ApiErrorSchema },
    503: { description: 'The database is unreachable. Retry later.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: true,
    body: {
      session_id: EXAMPLE_RESOURCE_ID,
      message: 'Summarize the attached report.',
      model: 'claude-opus-4-8',
    },
  },
});
