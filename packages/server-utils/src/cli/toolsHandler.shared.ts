import { cliTools } from '@bike4mind/services';
import type { ServerToolExecutors } from '@bike4mind/services';
import { adminSettingsRepository, apiKeyRepository, toolExecutionLogRepository } from '@bike4mind/database';

/**
 * Shared tool execution logic for both Lambda and Next.js API.
 *
 * Holds all validation/execution/logging logic so local dev (Next.js) and
 * production (Lambda) stay consistent. Make changes here only.
 */

export interface ToolExecutionContext {
  userId: string;
  userEmail?: string;
  logger: {
    info: (message: string) => void;
    error: (message: string, error?: any) => void;
  };
  /**
   * Host-supplied implementations for server tools whose code lives in the app tier (today:
   * `decide`, whose credit hold and provider retry are the decisions runner's, and the paid
   * `web_search` / `web_fetch`, billed per call). Each entry point builds them, so a missing one
   * fails that tool rather than running it un-billed.
   */
  executors?: ServerToolExecutors;
}

export interface ToolExecutionInput {
  toolName: string;
  input: Record<string, any>;
}

export const SUPPORTED_TOOLS = ['weather_info', 'web_search', 'web_fetch', 'decide'] as const;
export type SupportedTool = (typeof SUPPORTED_TOOLS)[number];

/** Validates a tool request; single source of truth for validation logic. */
export function validateToolRequest(
  body: any
): { valid: true; data: ToolExecutionInput } | { valid: false; error: string; statusCode: number } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be an object', statusCode: 400 };
  }

  if (!body.toolName || typeof body.toolName !== 'string') {
    return { valid: false, error: 'Missing or invalid toolName', statusCode: 400 };
  }

  if (!SUPPORTED_TOOLS.includes(body.toolName as any)) {
    return {
      valid: false,
      error: `Invalid tool name. Supported tools: ${SUPPORTED_TOOLS.join(', ')}`,
      statusCode: 400,
    };
  }

  if (!body.input || typeof body.input !== 'object') {
    return { valid: false, error: 'Invalid input: must be an object', statusCode: 400 };
  }

  return { valid: true, data: { toolName: body.toolName, input: body.input } };
}

/**
 * HTTP status for an executed tool: 200, a 422 for a billed tool the caller cannot afford (the status
 * every credit refusal uses, with `errorCode: insufficient_credits` in the body), else 500.
 */
export function toolResultStatus(result: { success: boolean; errorCode?: string }): 200 | 422 | 500 {
  if (result.success) return 200;
  return result.errorCode === 'insufficient_credits' ? 422 : 500;
}

/** Executes a tool and logs results; single source of truth for execution and audit logging. */
export async function executeToolWithLogging(request: ToolExecutionInput, context: ToolExecutionContext) {
  const { toolName, input } = request;
  const { userId, userEmail, logger, executors } = context;

  logger.info(`Executing tool ${toolName} for user ${userEmail || userId}`);

  const result = await cliTools.executeServerTool(
    {
      toolName: toolName as any,
      input,
      userId,
    },
    {
      db: {
        adminSettings: adminSettingsRepository,
        apiKeys: apiKeyRepository,
      },
    },
    executors
  );

  logger.info(`Tool ${toolName} ${result.success ? 'succeeded' : 'failed'} in ${result.executionTimeMs}ms`);

  // Audit log (non-blocking)
  toolExecutionLogRepository
    .create({
      userId,
      toolName,
      timestamp: new Date(),
      success: result.success,
      executionTimeMs: result.executionTimeMs || 0,
      error: result.error,
      errorType: result.errorType, // Error category for analytics
    })
    .catch(error => logger.error('Failed to write audit log:', error));

  return result;
}
