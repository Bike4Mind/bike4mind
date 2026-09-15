import { HTTPError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { connectDB } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { EventBridgeEvent } from 'aws-lambda';

/**
 * Wraps an EventBridge event handler with structured logging and DB connection.
 *
 * Error handling contract for event handlers:
 *
 * THROW (default) - Lambda reports failure; EventBridge may retry (depends on config).
 *   Use for: transient failures where retry is safe and idempotent.
 *
 * RETURN (swallow) - event is consumed, no retry.
 *   Use for: validation failures (malformed input, missing referenced records).
 *   Use for: non-critical side effects (auto-naming, tagging, analytics).
 *   Always log at WARN level with reason.
 *
 * Handler metadata convention:
 *   Call logger.updateMetadata({ handler: 'handlerName', ...domainFields })
 *   early in the handler to attach structured context to all subsequent logs.
 */
export const withEventContext = <T extends EventBridgeEvent<string, any>>(
  handler: (event: { event: string; properties: Record<string, any> }, logger: Logger) => Promise<void>
) => {
  return async (event: T) => {
    const eventName = event['detail-type'];
    const logger = new Logger({
      metadata: {
        event: eventName,
      },
    });

    logger.info({ ...event['detail'], eventName });

    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

    try {
      logger.info(`Processing ${eventName} event`);
      // Maintain SST v2 event structure for now
      await handler(
        {
          event: eventName,
          properties: event['detail'],
        },
        logger
      );
    } catch (error) {
      // 4xx = expected business error -> warn; 5xx / unknown = actual bug -> error
      if (error instanceof HTTPError && error.statusCode >= 400 && error.statusCode < 500) {
        logger.warn(`Expected error processing ${eventName} event`, { error });
      } else {
        logger.error(`Error processing ${eventName} event`, { error });
      }
      throw error;
    }
  };
};
