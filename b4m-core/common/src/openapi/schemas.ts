import { z } from 'zod';
import { registry } from './registry';
import {
  CompletionRequestSchema,
  CompletionMessageSchema,
  CompletionToolSchema,
  ResponseFormatSchema,
} from '../schemas/cliCompletions';

/**
 * OpenAPI component registrations for the public `/v1` surface.
 *
 * Request schemas are the SAME objects that validate requests at runtime
 * (imported from cliCompletions.ts), so the spec cannot drift from validation.
 * Response/SSE/error schemas are declared here because the wire responses are
 * assembled in handlers, not from a single Zod object - they MUST stay in sync
 * with their sources, noted per schema below.
 */

// --- Shared request components (reused inside CompletionRequest) ---
registry.register('CompletionMessage', CompletionMessageSchema.openapi('CompletionMessage'));
registry.register('CompletionTool', CompletionToolSchema.openapi('CompletionTool'));
registry.register('ResponseFormat', ResponseFormatSchema.openapi('ResponseFormat'));

export const CompletionRequest = registry.register(
  'CompletionRequest',
  CompletionRequestSchema.openapi('CompletionRequest', {
    description:
      'OpenAI-compatible completion request. Top-level `response_format`, `stream`, `tools`, ' +
      '`temperature`, and `max_tokens` are also accepted nested under `options` (legacy shape).',
    example: {
      model: 'claude-opus-4-8',
      messages: [
        { role: 'system', content: 'You are a support agent.' },
        { role: 'user', content: 'How do I reset my password?' },
      ],
      temperature: 0.7,
      max_tokens: 500,
    },
  })
);

// --- Completions response: an SSE stream, not a JSON body ---
// Must stay in sync with the SSE event interfaces in utils/sseEvents.ts.
const CompletionMetaEvent = z
  .object({
    type: z.literal('meta'),
    requestId: z.string(),
  })
  .openapi('CompletionMetaEvent', {
    description: 'First non-keepalive event; carries the correlation id for log lookup.',
  });

const CompletionUsage = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
});

const CompletionContentEvent = z
  .object({
    type: z.enum(['content', 'tool_use']),
    text: z.string(),
    tools: z
      .array(z.object({ name: z.string(), arguments: z.string().optional(), id: z.string().optional() }))
      .optional(),
    usage: CompletionUsage.optional(),
    credits: z.object({ used: z.number().optional(), usdCost: z.number().optional() }).optional(),
    responseFormatMode: z.enum(['native', 'tool_use', 'best-effort']).optional(),
    // Complete assistant message incl. reasoning blocks; present for Anthropic
    // extended thinking with tools (SSEContentEvent.thinking in sseEvents.ts).
    thinking: z.array(z.any()).optional(),
  })
  .openapi('CompletionContentEvent', {
    description: 'A streamed chunk of assistant output; `usage`/`credits` ride on the final chunks.',
  });

const CompletionSseErrorEvent = z
  .object({
    type: z.literal('error'),
    message: z.string(),
    requestId: z.string().optional(),
    code: z.string().optional(),
  })
  .openapi('CompletionSseErrorEvent', {
    description:
      'In-band stream error. The completions endpoint reports failures as this SSE event ' +
      '(HTTP status stays 200 once the stream has opened), terminating the stream.',
  });

export const CompletionStreamEvent = registry.register(
  'CompletionStreamEvent',
  z.union([CompletionMetaEvent, CompletionContentEvent, CompletionSseErrorEvent]).openapi('CompletionStreamEvent', {
    description:
      'One `data:` event in the `text/event-stream` response. Order: one `meta`, then one or ' +
      'more `content`/`tool_use` events, terminated by the literal line `data: [DONE]`. ' +
      'Comment lines (`: keep-alive`) are interleaved as heartbeats and carry no event.',
    example: {
      type: 'content',
      text: "To reset your password, click 'Forgot password' on the login screen.",
      usage: { inputTokens: 42, outputTokens: 12 },
      credits: { used: 1, usdCost: 0.00037 },
    },
  })
);

// --- Tools endpoint (POST /api/ai/v1/tools) ---
// toolName enum must stay in sync with SUPPORTED_TOOLS in
// apps/client/server/cli/toolsHandler.shared.ts.
export const ToolExecutionRequest = registry.register(
  'ToolExecutionRequest',
  z
    .object({
      toolName: z.enum(['weather_info', 'web_search', 'web_fetch']),
      input: z.record(z.string(), z.any()),
    })
    .openapi('ToolExecutionRequest', {
      description: 'Server-side tool execution request. Not the same shape as a completion `tools` entry.',
      example: { toolName: 'web_search', input: { query: 'how to reset a password' } },
    })
);

export const ToolExecutionResponse = registry.register(
  'ToolExecutionResponse',
  z
    .object({
      success: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional(),
      // Error category for analytics; set alongside `error` on failure (toolsHandler.shared.ts).
      errorType: z.string().optional(),
      executionTimeMs: z.number().optional(),
      request_id: z.string(),
    })
    .openapi('ToolExecutionResponse', {
      description: 'Tool execution result. `success: false` carries `error`; `request_id` echoes X-Request-ID.',
      example: {
        success: true,
        result: { summary: 'Top results for the query.' },
        executionTimeMs: 842,
        request_id: 'abc-123',
      },
    })
);

// --- Reusable JSON error envelope (tools 4xx/5xx, and any JSON error path) ---
export const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      error: z.string().openapi({ description: 'Human-readable error message.' }),
      request_id: z.string().optional().openapi({ description: 'Correlation id, mirrors the X-Request-ID header.' }),
    })
    .openapi('ErrorResponse', { example: { error: 'Missing or invalid toolName', request_id: 'abc-123' } })
);
