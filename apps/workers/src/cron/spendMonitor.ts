import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { connectDB, adminSettingsRepository, spendRollupRepository } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { z } from 'zod';
import { bucketsToRoll } from './spendMonitor/buckets';

const scheduledEventSchema = z.object({ time: z.iso.datetime() });

export async function handler(event: unknown): Promise<{ status: 'ok' | 'disabled'; rolled: number }> {
  const logger = new Logger().withMetadata({ cron: 'spendMonitor', stage: Resource.App.stage });
  // Event time stays fixed across delayed delivery and retries, so the closed-bucket set is stable.
  const now = new Date(scheduledEventSchema.parse(event).time);

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { skipCache: true });
  if (!getSettingsValue('spendMonitorEnabled', settings)) {
    logger.log('spend-monitor-disabled');
    return { status: 'disabled', rolled: 0 };
  }

  const latestRolled = await spendRollupRepository.latestBucketStart();
  const buckets = bucketsToRoll(now, latestRolled);
  // Sequential, oldest first: a failure leaves a contiguous rolled prefix for the next run to extend.
  for (const bucketStart of buckets) {
    const { docs } = await spendRollupRepository.rollupBucket(bucketStart);
    logger.log('spend-monitor-rolled', { bucketStart: bucketStart.toISOString(), docs });
  }
  return { status: 'ok', rolled: buckets.length };
}
