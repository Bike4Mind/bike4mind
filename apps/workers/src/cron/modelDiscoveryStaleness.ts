import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { connectDB, modelDiscoveryRunRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'modelDiscoveryStaleness' } });

export const MODEL_DISCOVERY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isModelDiscoveryStale(lastCompletedAt: Date | null, now: Date): boolean {
  return lastCompletedAt === null || now.getTime() - lastCompletedAt.getTime() >= MODEL_DISCOVERY_STALE_AFTER_MS;
}

/** Runs independently of discovery so a stopped discovery schedule is still observed. */
export async function handler(): Promise<void> {
  const stage = Resource.App.stage;
  const now = new Date();

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage), logger);
    const lastSuccessfulRun = await modelDiscoveryRunRepository.lastSuccessfulRun('hosted');
    const lastCompletedAt = lastSuccessfulRun
      ? new Date(lastSuccessfulRun.finishedAt ?? lastSuccessfulRun.startedAt)
      : null;
    const stale = isModelDiscoveryStale(lastCompletedAt, now);

    // Publish directly: the shared emitMetric helper swallows PutMetricData errors.
    // An emission failure must fail this watchdog invocation, not look healthy.
    const cloudWatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
    await cloudWatch.send(
      new PutMetricDataCommand({
        Namespace: 'Lumina5/ModelDiscovery',
        MetricData: [
          {
            MetricName: 'NoSuccessfulRun',
            Value: stale ? 1 : 0,
            Unit: StandardUnit.Count,
            Timestamp: now,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Host', Value: 'hosted' },
            ],
          },
        ],
      })
    );
  } catch (error) {
    logger.error('[model-discovery] staleness check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
