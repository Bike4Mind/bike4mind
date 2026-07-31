import { z } from 'zod';

/**
 * Server-side tool execution schemas for POST /api/ai/v1/tools.
 *
 * Plain Zod (no `.openapi()`) so any runtime can import them; the OpenAPI layer
 * annotates them via the contract. The tool-name enum MUST stay in sync with
 * SUPPORTED_TOOLS in apps/client/server/cli/toolsHandler.shared.ts.
 */
export const ToolExecutionRequestSchema = z.object({
  toolName: z.enum(['weather_info', 'web_search', 'web_fetch']),
  input: z.record(z.string(), z.any()),
});

export type ToolExecutionRequest = z.infer<typeof ToolExecutionRequestSchema>;

/**
 * Tool execution result. `success: false` carries `error`; `request_id` echoes
 * the X-Request-ID header. Must stay in sync with the response assembled in
 * toolsHandler.shared.ts.
 */
export const ToolExecutionResponseSchema = z.object({
  success: z.boolean(),
  result: z.any().optional(),
  error: z.string().optional(),
  errorType: z.string().optional(),
  executionTimeMs: z.number().optional(),
  request_id: z.string(),
});

export type ToolExecutionResponse = z.infer<typeof ToolExecutionResponseSchema>;
