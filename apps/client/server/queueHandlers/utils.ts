import { connectDB } from '@bike4mind/database';
import { HTTPError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { registerToolGearObserver } from '@server/services/gears/toolGearObserver';
import { contextToLogs } from '@server/utils/logger';
import { Context, SQSEvent } from 'aws-lambda';
import { handleWarmerInvocation } from '@server/utils/warmer';

// Gears: hook the shared tool pipeline once per lambda (fire-and-forget observer).
registerToolGearObserver();

/**
 * Wraps an SQS queue handler with structured logging and DB connection.
 *
 * Error handling contract for queue handlers:
 *
 * THROW (default) - SQS retries the message, then routes to DLQ.
 *   Use for: transient failures (network, timeout, DB connection).
 *   Use for: single-record handlers where the entire operation should retry.
 *
 * RETURN (swallow) - message is consumed, no retry.
 *   Use for: validation failures (malformed input, missing referenced records).
 *   Use for: non-critical side effects (auto-naming, analytics).
 *   Always log at WARN level with reason.
 *
 * CONTINUE (batch) - skip failed record, process remaining.
 *   Use for: batch handlers processing multiple records in one invocation, on a queue
 *   subscribed with `batch: { partialResponses: true }`.
 *   Track success/failure counts, log a summary, and return
 *   `{ batchItemFailures: [{ itemIdentifier: record.messageId }, ...] }` for the failed
 *   records only (omit succeeded ones) so SQS retries/DLQs just the failures.
 *
 * Handler metadata convention:
 *   Call logger.updateMetadata({ handler: 'handlerName', ...domainFields })
 *   early in the handler to attach structured context to all subsequent logs.
 */
export const dispatchWithLogger = <T = void>(
  handler: (event: SQSEvent, context: Context, logger: Logger) => Promise<T>
) => {
  return async (event: SQSEvent, context: Context): Promise<T | void> => {
    const logger = new Logger().withMetadata(contextToLogs(context));
    // Check if this is a warmer invocation and exit early if it is
    if (handleWarmerInvocation(event)) {
      logger.info('Skipping warmer invocation');
      return;
    }

    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

    try {
      // logger.info(`Starting Queue Handler: ${context.functionName}`);
      return await handler(event, context, logger);
    } catch (error) {
      // 4xx = expected business error (insufficient credits, validation) -> warn
      // 5xx / unknown = actual bug -> error (triggers CloudWatch -> SRE pipeline)
      if (error instanceof HTTPError && error.statusCode >= 400 && error.statusCode < 500) {
        logger.warn(error);
      } else {
        logger.error(error);
      }
      throw error;
    }
  };
};
