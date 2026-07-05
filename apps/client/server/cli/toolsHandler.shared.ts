import { cliTools } from '@bike4mind/services';
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
}

export interface ToolExecutionInput {
  toolName: string;
  input: Record<string, any>;
}

export const SUPPORTED_TOOLS = ['weather_info', 'web_search', 'web_fetch'] as const;
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

/** Executes a tool and logs results; single source of truth for execution and audit logging. */
export async function executeToolWithLogging(request: ToolExecutionInput, context: ToolExecutionContext) {
  const { toolName, input } = request;
  const { userId, userEmail, logger } = context;

  logger.info(`Executing tool ${toolName} for user ${userEmail || userId}`);

  // Execute tool using shared service
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
    }
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
