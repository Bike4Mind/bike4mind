import { toolExecutionLogRepository } from '@bike4mind/database';

/**
 * Runs one /api/tools/* execution and writes the same toolExecutionLogRepository audit record as
 * executeToolWithLogging (toolsHandler.shared.ts). Those routes keep their own execution (52s
 * Firecrawl cap, page title, weather timeout) instead of cliTools.executeServerTool, so they wrap
 * it here. Errors are rethrown unchanged; the audit write is non-blocking.
 */
export async function runAuditedTool<T>(
  toolName: string,
  userId: string,
  logger: { error: (message: string, error?: unknown) => void },
  run: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();
  let failure: { error: unknown } | undefined;
  try {
    return await run();
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    toolExecutionLogRepository
      .create({
        userId,
        toolName,
        timestamp: new Date(),
        success: !failure,
        executionTimeMs: Date.now() - startTime,
        error: failure && (failure.error instanceof Error ? failure.error.message : String(failure.error)),
      })
      .catch(logError => logger.error('Failed to write tool audit log:', logError));
  }
}
