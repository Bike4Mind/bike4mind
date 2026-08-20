import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts
// (the barrel drags in @bike4mind/hearth, unbuilt in the CI openapi job).
import { CompletionRequestSchema, CompletionStreamEventSchema } from '../../schemas/cliCompletions';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Contract for POST /api/ai/v1/completions - the public streaming completions
 * endpoint. Served by the always-on ChatCompletion Fargate service as an SSE
 * stream (server/chatCompletion/external/sseRoute.ts), NOT a request/response
 * adapter - the handler derives its request schema + auth from this contract via
 * resolveContractAuth, but owns the stream itself. See the api-contract README:
 * an SSE transport adapter is deferred until a second streaming endpoint exists.
 */
export const createCompletionContract = defineEndpoint({
  method: 'post',
  path: '/api/ai/v1/completions',
  operationId: 'createCompletion',
  summary: 'Create a chat completion',
  description:
    'OpenAI-compatible completion. The response is ALWAYS an SSE stream (`text/event-stream`), ' +
    'regardless of the `stream` flag: a `meta` event, then `content`/`tool_use` events carrying ' +
    '`usage`/`credits`, terminated by `data: [DONE]`. Once the stream has opened the HTTP status ' +
    'stays 200 and failures arrive as an in-band `error` event. The terminal event carries ' +
    '`stopReason`; treat `max_tokens` as a TRUNCATED reply rather than a complete one, and note ' +
    'that omitting `max_tokens` on the request lets the server size the output ceiling for the ' +
    'model (recommended for reasoning models, which spend thinking tokens inside that ceiling). ' +
    'Authenticate with an API key (`b4m_live_`) or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  request: CompletionRequestSchema,
  requestExample: {
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'How do I reset my password?' }],
    max_tokens: 500,
  },
  streaming: true,
  responses: {
    200: {
      description: 'SSE stream of completion events (see the CompletionStreamEvent shape).',
      contentType: 'text/event-stream',
      schema: CompletionStreamEventSchema,
      example: {
        type: 'content',
        text: "To reset your password, click 'Forgot password' on the login screen.",
        usage: { inputTokens: 42, outputTokens: 12 },
        credits: { used: 1, usdCost: 0.00037 },
        stopReason: 'end_turn',
      },
    },
    400: { description: 'Malformed JSON body (rejected before the stream opens).', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: true,
    body: {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'How do I reset my password?' }],
      max_tokens: 500,
    },
  },
});
