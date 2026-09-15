import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { connectDB, userApiKeyRepository } from '@bike4mind/database';
import { ApiKeyStatus } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';
import { ApiKeyUsageManager } from '@server/managers/apiKeyUsageManager';

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

/**
 * Lambda handler for calculating API key usage baselines.
 * Runs daily via EventBridge cron to update baseline patterns for all active API keys.
 */
export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
    logger.log('Connected to database');

    // Use model directly to get Mongoose documents with id virtual
    const activeKeys = await userApiKeyRepository.find({
      status: ApiKeyStatus.ACTIVE,
    });

    logger.log(`Found ${activeKeys.length} active API keys to process`);

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    // Group keys by userId to process users sequentially
    const keysByUser = new Map<string, (typeof activeKeys)[number][]>();
    activeKeys.forEach(key => {
      if (!keysByUser.has(key.userId)) {
        keysByUser.set(key.userId, []);
      }
      keysByUser.get(key.userId)!.push(key);
    });

    logger.log(`Processing ${keysByUser.size} unique users`);

    for (const [userId, userKeys] of Array.from(keysByUser.entries())) {
      logger.debug(`Processing user ${userId} with ${userKeys.length} API key(s)`);

      for (const apiKey of userKeys) {
        try {
          const baseline = await ApiKeyUsageManager.calculateBaseline(userId, apiKey.id, logger);

          if (baseline === null) {
            logger.debug(`No baseline calculated for key ${apiKey.id} (no usage history)`);
            skipped++;
            continue;
          }

          await userApiKeyRepository.updateBaseline(apiKey.id, baseline);

          logger.debug(`Updated baseline for key ${apiKey.id}`, {
            keyId: apiKey.id,
            userId,
            baseline: {
              avgRequestsPerHour: baseline.avgRequestsPerHour,
              avgRequestsPerDay: baseline.avgRequestsPerDay,
              commonIPsCount: baseline.commonIPs.length,
              commonEndpointsCount: baseline.commonEndpoints.length,
            },
          });

          processed++;
        } catch (error) {
          errors++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to calculate baseline for key ${apiKey.id}`, {
            keyId: apiKey.id,
            userId,
            error: errorMessage,
          });
        }
      }
    }

    logger.log('Baseline calculation completed', {
      total: activeKeys.length,
      processed,
      skipped,
      errors,
    });

    return {
      status: 'success',
      processed,
      skipped,
      errors,
      total: activeKeys.length,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stackTrace = error instanceof Error ? error.stack : 'No stack trace';
    logger.error('Error in API key baseline calculation', {
      error: errorMessage,
      stack: stackTrace,
    });
    return {
      status: 'error',
      reason: errorMessage,
      stack: stackTrace,
    };
  }
}
