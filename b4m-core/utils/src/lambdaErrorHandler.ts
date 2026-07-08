import type { ILogger } from '@bike4mind/observability';

let isRegistered = false;

type ErrorCategory =
  | 'network_terminated'
  | 'network_timeout'
  | 'network_connection'
  | 'unhandled_rejection'
  | 'uncaught_exception';

/**
 * Classifies an error into a category for structured logging and metrics.
 */
function classifyError(error: unknown): ErrorCategory {
  if (error instanceof TypeError) {
    // undici/fetch termination errors
    if (error.message === 'terminated' || error.message.includes('fetch failed')) {
      return 'network_terminated';
    }
  }
  if (error instanceof Error) {
    // AbortController timeout
    if (error.name === 'AbortError') {
      return 'network_timeout';
    }
    // Connection errors
    const connectionErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'];
    if (connectionErrors.some(code => error.message.includes(code))) {
      return 'network_connection';
    }
  }
  return 'unhandled_rejection';
}

/**
 * Builds a structured log entry for the global error handlers.
 */
function buildLogEntry(error: unknown, category: ErrorCategory) {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    category,
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    stage: process.env.SEED_STAGE_NAME,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Registers global handlers for unhandled promise rejections and uncaught exceptions.
 *
 * Provider-agnostic core shared by Lambda handlers and the always-on
 * ChatCompletion container. The handlers:
 * 1. Log errors with structured context
 * 2. Classify error types for easier debugging
 * 3. Distinguish network errors from application errors and swallow the network
 *    class (mark the rejection handled / don't re-throw) so a single transient
 *    network failure doesn't escalate
 *
 * CRITICAL for long-running processes: these handlers NEVER call process.exit().
 * On AWS Lambda that lets the runtime own the lifecycle. On a long-running Fargate
 * task it means one quest's mid-stream EPIPE / orphaned undici rejection is
 * logged and swallowed instead of taking Node's default
 * `uncaughtException` path, which would terminate the whole container and kill
 * every other in-flight quest.
 *
 * @param logger - Optional logger instance. Falls back to console if not provided.
 * @param context - Short label used in log message prefixes (default 'Process').
 *
 * @example
 * ```typescript
 * import { registerProcessErrorHandlers } from '@bike4mind/utils';
 *
 * // Call once at startup, after imports
 * registerProcessErrorHandlers(logger, 'ChatCompletion');
 * ```
 */
export function registerProcessErrorHandlers(logger?: ILogger, context: string = 'Process'): void {
  if (isRegistered) return;
  isRegistered = true;

  const log = logger || console;

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    const category = classifyError(reason);
    const isNetworkError = category.startsWith('network_');
    const logEntry = buildLogEntry(reason, category);

    if (isNetworkError) {
      // Network errors are expected (e.g. client disconnects, request timeouts) - log as warning
      log.warn(`[${context}] Network error (unhandled rejection)`, logEntry);
      // Mark the rejection as handled so the runtime doesn't escalate it for
      // transient network failures that escape try/catch via orphaned undici
      // promises.
      promise.catch(() => {});
    } else {
      // Unexpected errors - log as error
      log.error(`[${context}] Unhandled promise rejection`, logEntry);
    }

    // DO NOT call process.exit() - one bad request must not kill a long-running process
  });

  process.on('uncaughtException', (error: Error) => {
    const category = classifyError(error);
    const isNetworkError = category.startsWith('network_');

    if (isNetworkError) {
      // Transient network write failures (e.g. EPIPE when a client disconnects
      // mid-write) surface as uncaught exceptions but are not application
      // faults - log as a warning so they don't trip error-severity alerts.
      log.warn(`[${context}] Network error (uncaught exception)`, buildLogEntry(error, category));
    } else {
      log.error(`[${context}] Uncaught exception`, buildLogEntry(error, 'uncaught_exception'));
    }

    // DO NOT call process.exit() - one bad request must not kill a long-running process
  });
}

/**
 * Back-compat alias for Lambda handlers. Preserves the historical `[Lambda]` log
 * prefix so existing log-based filters/alerts are unaffected. New code on
 * non-Lambda runtimes should call {@link registerProcessErrorHandlers} directly.
 *
 * @param logger - Optional logger instance. Falls back to console if not provided.
 */
export function registerLambdaErrorHandlers(logger?: ILogger): void {
  registerProcessErrorHandlers(logger, 'Lambda');
}

/**
 * Reset the registration state. Only for testing purposes.
 * @internal
 */
export function _resetLambdaErrorHandlers(): void {
  isRegistered = false;
}
