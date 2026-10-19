import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts
// (the barrel drags in @bike4mind/hearth, unbuilt in the CI openapi job).
import { CompletionRequestSchema, CompletionStreamEventSchema } from '../../schemas/cliCompletions';
import {
  ApiErrorSchema,
  InsufficientCreditsErrorSchema,
  ProviderNotConfiguredErrorSchema,
  CompletionsBadRequestErrorSchema,
} from '../../schemas/chat';

/**
 * Contract for POST /api/ai/v1/completions - the public streaming completions
 * endpoint. Served by the always-on ChatCompletion Fargate service as an SSE
 * stream (server/chatCompletion/external/sseRoute.ts), NOT a request/response
 * adapter - the handler derives its request schema + auth from this contract via
 * resolveContractAuth, but owns the stream itself. See the api-contract README:
 * an SSE transport adapter is deferred until a second streaming endpoint exists.
 *
 * 401, the scope 403 and 405 are injected by registerContract; 405 cannot be declared
 * here because it is outside the conventions' status table.
 */
export const createCompletionContract = defineEndpoint({
  method: 'post',
  path: '/api/ai/v1/completions',
  operationId: 'createCompletion',
  summary: 'Create a chat completion',
  description:
    'OpenAI-compatible completion. A successful request is ALWAYS answered with an SSE stream ' +
    '(`text/event-stream`), regardless of the `stream` flag: a `meta` event, then `content`/`tool_use` ' +
    'events carrying `usage`/`credits`, terminated by `data: [DONE]`. The terminal event carries ' +
    '`stopReason`; treat `max_tokens` as a TRUNCATED reply rather than a complete one, and note ' +
    'that omitting `max_tokens` on the request lets the server size the output ceiling for the ' +
    'model (recommended for reasoning models, which spend thinking tokens inside that ceiling). ' +
    'A message `content` may be a string or an array of parts; image parts are accepted in ' +
    'OpenAI Chat (`image_url`), OpenAI Responses (`input_image`) or Anthropic (`image` with a ' +
    '`source`) form and are translated to whatever the target model speaks. ' +
    'Authenticate with an API key (`b4m_live_`) or a JWT.\n\n' +
    'TOOL SEARCH. On a model whose `GET /api/v1/models` row has `supports_tool_search: true` and `backend: "anthropic"`, ' +
    'a `tools` entry may set `toolSchema.defer_loading: true`, and a `{ "serverTool": { "type": ' +
    '"tool_search_tool_regex_20251119", "name": "tool_search_tool_regex" } }` (or the `bm25` pair) entry adds ' +
    "Anthropic's tool search, so deferred definitions load only when the model searches for them. The stream then " +
    'carries `provider_block` events (`{ type, provider: "anthropic", block }`) for the server-run search; echo each ' +
    'block back verbatim, in order, in the assistant `messages` content of the next request, and never answer one with a ' +
    '`tool_result`. When the server-run search loop hits its iteration limit the stream ends with `stopReason: ' +
    '"pause_turn"`; continue by re-sending the conversation with that assistant turn\'s provider blocks echoed. ' +
    'A client-side search may return `{ "type": "tool_reference", "tool_name": "..." }` blocks inside ' +
    "a `tool_result`'s content. On every other model, Bedrock-served Claude included, `defer_loading` is ignored (every " +
    'tool is sent as usual) and a server tool, a `tool_reference` or an echoed tool search block is refused with a ' +
    '`400` rather than run without it.\n\n' +
    'ERRORS. Everything checked before the model provider is called fails with a JSON error body and ' +
    'a real HTTP status, before any stream opens: a malformed or otherwise invalid request or an unknown `model` `400` (`errorCode: "unknown_model"` for the latter), a bad ' +
    'credential `401`, a key without a required scope `403` (with `required_scopes`), a body over 25 MB ' +
    '`413`, a body that fails schema validation `422`, insufficient credits `422` with ' +
    '`errorCode: "insufficient_credits"` (personal or org balance, or an org per-member credit cap), a rate limit `429` with `Retry-After`, and a catalogued model ' +
    'whose provider is not configured on this deployment `503` with `errorCode: "provider_not_configured"` (retryable). ' +
    'Once the stream has opened the status stays `200` and a failure arrives as one terminal in-band ' +
    "`error` event. Branch on that event's `code`, never on `message`, which is prose and may change: " +
    '`insufficient_credits` (buy credits) when credits run out mid-generation, `provider_rejected` when the model provider ' +
    'refused our credentials, `content_blocked` when the model declined the request (do not retry it unchanged), and ' +
    '`provider_error` for any other provider failure. Treat `code` as optional.',
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
    400: {
      description:
        'Malformed or otherwise invalid request (no `errorCode`), or a `model` the caller cannot use (`errorCode: "unknown_model"`): ' +
        'not in the catalog or not available to the caller. List valid ids with `GET /api/v1/models`. Tool search requests ' +
        'are refused with: `tool_search_unsupported` (a server tool, `tool_reference` or echoed tool search block on a model ' +
        'that cannot serve tool search here), `all_tools_deferred` (every tool deferred and no server tool), ' +
        '`deferred_tool_cache_control` (`cache_control` on a deferred tool), `unknown_tool_reference` (a `tool_reference` ' +
        'naming a tool not in `tools`, or carrying no string `tool_name`).',
      schema: CompletionsBadRequestErrorSchema,
    },
    413: { description: 'Request body over 25 MB.', schema: ApiErrorSchema },
    422: {
      description:
        'The body failed schema validation, or the caller cannot afford the request ' +
        '(`errorCode: "insufficient_credits"`: personal or org balance, or an org per-member credit cap).',
      schema: InsufficientCreditsErrorSchema,
    },
    429: {
      description: 'Rate limit exceeded.',
      schema: ApiErrorSchema,
      headers: { 'Retry-After': 'Seconds to wait before retrying.' },
    },
    500: { description: 'Internal error before the stream opened.', schema: ApiErrorSchema },
    503: {
      description:
        "Temporarily unavailable: the model's provider is not configured on this deployment " +
        '(`errorCode: "provider_not_configured"`), or the database is unreachable (no `errorCode`). Retry later.',
      schema: ProviderNotConfiguredErrorSchema,
    },
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
