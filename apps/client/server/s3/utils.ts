import { Logger } from '@bike4mind/observability';
import { connectDB } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { contextToLogs } from '@server/utils/logger';
import { Context, S3Event } from 'aws-lambda';

/** Decode URL-encoded S3 event key (spaces are '+', special chars are %XX) */
export const decodeS3Key = (key: string): string => decodeURIComponent(key.replace(/\+/g, ' '));

export const withContext = (handler: (event: S3Event, context: Context, logger: Logger) => Promise<void>) => {
  return async (event: S3Event, context: Context) => {
    const logger = new Logger().withMetadata(contextToLogs(context));
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

    try {
      await handler(event, context, logger);
    } catch (error) {
      logger.error(error);
      throw error;
    }
  };
};

/**
 * Retries a database lookup with exponential backoff to handle race conditions
 * where an S3 event fires before the metadata record is fully replicated.
 *
 * Retry schedule (default): 1s -> 2s -> 4s (3 retries after initial attempt)
 *
 * `T` is inferred as the full awaited return type of `findFn` (e.g.
 * `IFabFileDocument | null`), so Mongoose Query thenables are compatible.
 */
export const findWithRetry = async <T>(
  findFn: () => PromiseLike<T>,
  maxRetries = 3,
  initialDelayMs = 1000
): Promise<T | null> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const result = await findFn();
    // Treat both null and undefined as "not found" (Mongoose findOne returns
    // null when no document matches)
    if (result != null) return result;
  }

  return null;
};
