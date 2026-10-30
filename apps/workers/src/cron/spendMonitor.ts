import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { MIN_PRICE_PER_CREDIT_USD, SPEND_BUCKET_MS } from '@bike4mind/common';
import { connectDB, adminSettingsRepository, spendAlertRepository, spendRollupRepository } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { z } from 'zod';
import { appUrlFromEnv, postAlarmToSlack, resolveAlarmWebhookUrl } from '../events/alarmSlackMessage';
import { readAlarmMention } from '../events/alarmSlackMention';
import { bucketsToRoll } from './spendMonitor/buckets';
import { evaluateSpend } from './spendMonitor/evaluate';
import { defaultResolveScopeDeps } from './spendMonitor/resolveScope';
import type { SpendThresholds } from './spendMonitor/rules';
import { createSpendPost } from './spendMonitor/slackPost';

const scheduledEventSchema = z.object({ time: z.iso.datetime() });

type SettingsMap = Awaited<ReturnType<typeof getSettingsMap>>;
type ThresholdKey =
  | 'spendMonitorPlatformSpikeRatio'
  | 'spendMonitorPlatformCriticalRatio'
  | 'spendMonitorPlatformSpikeFloorCredits'
  | 'spendMonitorPlatformCostFloorUsd'
  | 'spendMonitorAccountSpikeRatio'
  | 'spendMonitorAccountSpikeFloorCredits'
  | 'spendMonitorAccountCeilingCredits';

function readThresholds(settings: SettingsMap): SpendThresholds {
  const read = (key: ThresholdKey): number => {
    const value = getSettingsValue(key, settings);
    if (value === undefined) throw new Error(`Setting ${key} resolved to no value`);
    return value;
  };
  return {
    platformSpikeRatio: read('spendMonitorPlatformSpikeRatio'),
    platformCriticalRatio: read('spendMonitorPlatformCriticalRatio'),
    platformSpikeFloorCredits: read('spendMonitorPlatformSpikeFloorCredits'),
    platformCostFloorUsd: read('spendMonitorPlatformCostFloorUsd'),
    accountSpikeRatio: read('spendMonitorAccountSpikeRatio'),
    accountSpikeFloorCredits: read('spendMonitorAccountSpikeFloorCredits'),
    accountCeilingCredits: read('spendMonitorAccountCeilingCredits'),
  };
}

/** The catch-up cap leaves the buckets it skips empty for good, so baselines spanning them read low until they age out. */
function logCappedCatchUp(logger: Pick<Logger, 'log'>, latestRolled: Date | null, buckets: Date[]): void {
  const [firstRolled] = buckets;
  if (!latestRolled || !firstRolled) return;
  const droppedBuckets = (firstRolled.getTime() - latestRolled.getTime()) / SPEND_BUCKET_MS - 1;
  if (droppedBuckets <= 0) return;
  logger.log('spend-monitor-catch-up-capped', {
    latestRolled: latestRolled.toISOString(),
    firstRolled: firstRolled.toISOString(),
    droppedBuckets,
  });
}

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
  logCappedCatchUp(logger, latestRolled, buckets);
  // Sequential, oldest first: a failure leaves a contiguous rolled prefix for the next run to extend.
  for (const bucketStart of buckets) {
    const { docs } = await spendRollupRepository.rollupBucket(bucketStart);
    logger.log('spend-monitor-rolled', { bucketStart: bucketStart.toISOString(), docs });
  }

  const slackEnabled = getSettingsValue('spendMonitorSlackEnabled', settings) ?? false;
  const webhookUrl = resolveAlarmWebhookUrl(Resource);
  const { breaches, posted } = await evaluateSpend(
    now,
    {
      rollups: spendRollupRepository,
      alerts: spendAlertRepository,
      resolveScopeDeps: defaultResolveScopeDeps(),
      post: createSpendPost(slackEnabled, message => postAlarmToSlack(webhookUrl, message), logger),
      messageContext: {
        creditUsd: MIN_PRICE_PER_CREDIT_USD,
        stage: Resource.App.stage,
        appUrl: appUrlFromEnv(),
        mention: await readAlarmMention(),
      },
      logger,
    },
    readThresholds(settings)
  );
  logger.log('spend-monitor-evaluated', { breaches, posted });
  return { status: 'ok', rolled: buckets.length };
}
