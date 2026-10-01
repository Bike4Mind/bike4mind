import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { connectDB, Quest } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

const cleanupLogger = new Logger({ metadata: { service: 'telemetryCleanup' } });

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

/**
 * Telemetry TTL Cleanup - GDPR Article 5(1)(e) storage limitation.
 * Removes contextTelemetry from Quest documents older than 90 days.
 * Runs daily via EventBridge cron.
 */
export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
    logger.log('Connected to database');

    const result = await runTelemetryCleanup({ logger });

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error) {
    logger.error('[TelemetryCleanup] Failed:', error);
    throw error;
  }
}

export async function runTelemetryCleanup(options: { logger?: Logger; batchSize?: number } = {}) {
  const logger = options.logger ?? cleanupLogger;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 90);

  // Process in batches to avoid MongoDB write lock contention on large datasets
  const batchSize = options.batchSize ?? 5000;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid telemetry cleanup batch size');
  let totalModified = 0;
  let batchCount = 0;

  // Include tombstones in both operations so soft deletion cannot bypass retention.
  while (true) {
    const batch = await Quest.find(
      { timestamp: { $lt: cutoff }, 'promptMeta.contextTelemetry': { $exists: true } },
      { _id: 1 }
    )
      .setOptions({ includeDeleted: true })
      .limit(batchSize)
      .lean();

    if (batch.length === 0) break;

    const ids = batch.map(q => q._id);
    const result = await Quest.updateMany(
      { _id: { $in: ids } },
      { $unset: { 'promptMeta.contextTelemetry': '' } }
    ).setOptions({ includeDeleted: true });

    totalModified += result.modifiedCount;
    batchCount++;
    logger.log(`[TelemetryCleanup] Batch ${batchCount}: cleaned ${result.modifiedCount} quests`);
  }

  logger.log(
    `[TelemetryCleanup] Removed contextTelemetry from ${totalModified} quests in ${batchCount} batches (cutoff: ${cutoff.toISOString()})`
  );
  return { modifiedCount: totalModified, batches: batchCount, cutoff: cutoff.toISOString() };
}
