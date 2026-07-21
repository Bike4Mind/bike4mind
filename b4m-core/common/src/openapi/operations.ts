import { registry } from './registry';
import { SECURITY_REQUIREMENT } from './security';
import {
  CompletionRequest,
  CompletionStreamEvent,
  ToolExecutionRequest,
  ToolExecutionResponse,
  ErrorResponse,
} from './schemas';

/**
 * Operation (path) registrations for the versioned `/v1` surface.
 *
 * operationIds are stable camelCase - they become SDK method names, so treat
 * them as a public contract. Per-operation required scopes and code samples are
 * attached as vendor extensions (`x-required-scopes`, `x-codeSamples`) in
 * document.ts after generation, keyed by operationId.
 */

registry.registerPath({
  method: 'post',
  path: '/api/ai/v1/completions',
  operationId: 'createCompletion',
  summary: 'Create a chat completion',
  description:
    'OpenAI-compatible completion. The response is ALWAYS an SSE stream (`text/event-stream`), ' +
    'regardless of the `stream` flag: a `meta` event, then `content`/`tool_use` events carrying ' +
    '`usage`/`credits`, terminated by `data: [DONE]`. Once the stream has opened the HTTP status ' +
    'stays 200 and failures arrive as an in-band `error` event. Authenticate with an API key ' +
    '(`b4m_live_`) or a JWT.',
  tags: ['AI'],
  security: SECURITY_REQUIREMENT,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CompletionRequest } },
    },
  },
  responses: {
    200: {
      description: 'SSE stream of completion events (see CompletionStreamEvent).',
      content: { 'text/event-stream': { schema: CompletionStreamEvent } },
    },
    400: {
      description: 'Malformed JSON body (rejected before the stream opens).',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/ai/v1/tools',
  operationId: 'executeTool',
  summary: 'Execute a server-side tool',
  description:
    'Runs one of the built-in server-side tools (`weather_info`, `web_search`, `web_fetch`) and ' +
    'returns its result as JSON. Rate-limited to 100 requests/hour. `request_id` echoes the ' +
    'X-Request-ID response header.',
  tags: ['AI'],
  security: SECURITY_REQUIREMENT,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: ToolExecutionRequest } },
    },
  },
  responses: {
    200: {
      description: 'Tool executed successfully (`success` is always true here).',
      content: { 'application/json': { schema: ToolExecutionResponse } },
    },
    400: {
      description: 'Missing/invalid `toolName` or `input`.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      // The handler returns the full ToolExecutionResponse (`success: false`) on a
      // failed-but-executed tool, not the bare ErrorResponse - match that shape.
      description: 'Tool execution failed; body carries `success: false` with `error`.',
      content: { 'application/json': { schema: ToolExecutionResponse } },
    },
  },
});
