import { connectDB } from '@bike4mind/database';
import { ensureModelPriceCatalog } from '@server/utils/modelPriceCatalogInit';
import { HTTPError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { contextToLogs } from '@server/utils/logger';
import { Context, SQSEvent } from 'aws-lambda';
import { handleWarmerInvocation } from '@server/utils/warmer';

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
 *   Use for: batch handlers processing multiple records in one invocation.
 *   Always track success/failure counts and log summary.
 *   Throw if ALL records fail (indicates systemic issue).
 *
 * Handler metadata convention:
 *   Call logger.updateMetadata({ handler: 'handlerName', ...domainFields })
 *   early in the handler to attach structured context to all subsequent logs.
 */
export const dispatchWithLogger = (handler: (event: SQSEvent, context: Context, logger: Logger) => Promise<void>) => {
  return async (event: SQSEvent, context: Context) => {
    const logger = new Logger().withMetadata(contextToLogs(context));
    // Check if this is a warmer invocation and exit early if it is
    if (handleWarmerInvocation(event)) {
      logger.info('Skipping warmer invocation');
      return;
    }

    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

    // One-time per process: wire the versioned model-price catalog.
    ensureModelPriceCatalog();

    try {
      // logger.info(`Starting Queue Handler: ${context.functionName}`);
      await handler(event, context, logger);
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
