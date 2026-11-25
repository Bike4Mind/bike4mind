import { defaultAccountContextDeps } from '@bike4mind/server-utils/lib/accounts/accountContext';
import { Logger, type ILogger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { MIN_PRICE_PER_CREDIT_USD, SPEND_BUCKET_MS } from '@bike4mind/common';
import {
  connectDB,
  adminAuditLogRepository,
  adminSettingsRepository,
  spendAlertRepository,
  spendFreezeRepository,
  spendRollupRepository,
  withTransaction,
} from '@bike4mind/database';
import { spendFreezeService } from '@bike4mind/services';
import { systemAuditActor } from '@bike4mind/server-utils/utils/adminAudit';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { z } from 'zod';
import { appUrlFromEnv, postAlarmToSlack, resolveAlarmWebhookUrl } from '../events/alarmSlackMessage';
import { readAlarmMention } from '../events/alarmSlackMention';
import { runAutoPause, type AutoPauseConfig, type AutoPauseDeps } from './spendMonitor/autoPause';
import { defaultPaidScopeDeps } from './spendMonitor/paidScopes';
import { defaultTopAccountContextDeps } from './spendMonitor/topAccountContext';
import { bucketsToRoll } from './spendMonitor/buckets';
import { evaluateSpend } from './spendMonitor/evaluate';
import { isMarginCheckSlot, runMarginCheck, type MarginThresholds } from './spendMonitor/marginCheck';
import { defaultResolveScopeDeps } from './spendMonitor/resolveScope';
import type { SpendThresholds } from './spendMonitor/rules';
import { createSpendPost } from './spendMonitor/slackPost';
import { parseSpendTrustConfig, type SpendTrustConfig } from './spendMonitor/trust';

const scheduledEventSchema = z.object({ time: z.iso.datetime() });

type SettingsMap = Awaited<ReturnType<typeof getSettingsMap>>;
type ThresholdKey =
  | 'spendMonitorPlatformSpikeRatio'
  | 'spendMonitorPlatformCriticalRatio'
  | 'spendMonitorPlatformSpikeFloorCredits'
  | 'spendMonitorPlatformCostFloorUsd'
  | 'spendMonitorAccountSpikeRatio'
  | 'spendMonitorAccountSpikeFloorCredits'
  | 'spendMonitorAccountCeilingCredits'
  | 'spendMonitorPaidAccountSpikeFloorCredits'
  | 'spendMonitorPaidAccountCeilingCredits'
  | 'spendMonitorPaidAccountMinAgeDays'
  | 'spendMonitorTrustedAccountSpikeFloorCredits'
  | 'spendMonitorTrustedAccountCeilingCredits'
  | 'spendMonitorMarginMinRatio'
  | 'spendMonitorMarginWindowHours'
  | 'spendMonitorMarginCostFloorUsd';

function readNumber(key: ThresholdKey, settings: SettingsMap): number {
  const value = getSettingsValue(key, settings);
  if (value === undefined) throw new Error(`Setting ${key} resolved to no value`);
  return value;
}

function readThresholds(settings: SettingsMap): SpendThresholds {
  const riskScoring = getSettingsValue('signupRiskScoring', settings);
  if (riskScoring === undefined) throw new Error('Setting signupRiskScoring resolved to no value');
  const read = (key: ThresholdKey): number => readNumber(key, settings);
  return {
    platformSpikeRatio: read('spendMonitorPlatformSpikeRatio'),
    platformCriticalRatio: read('spendMonitorPlatformCriticalRatio'),
    platformSpikeFloorCredits: read('spendMonitorPlatformSpikeFloorCredits'),
    platformCostFloorUsd: read('spendMonitorPlatformCostFloorUsd'),
    accountSpikeRatio: read('spendMonitorAccountSpikeRatio'),
    paidAccountMinAgeDays: read('spendMonitorPaidAccountMinAgeDays'),
    riskReviewScoreThreshold: riskScoring.reviewThreshold,
    accountSpikeFloorCredits: read('spendMonitorAccountSpikeFloorCredits'),
    accountCeilingCredits: read('spendMonitorAccountCeilingCredits'),
    paidAccountSpikeFloorCredits: read('spendMonitorPaidAccountSpikeFloorCredits'),
    paidAccountCeilingCredits: read('spendMonitorPaidAccountCeilingCredits'),
    trustedAccountSpikeFloorCredits: read('spendMonitorTrustedAccountSpikeFloorCredits'),
    trustedAccountCeilingCredits: read('spendMonitorTrustedAccountCeilingCredits'),
  };
}

function readMarginThresholds(settings: SettingsMap): MarginThresholds {
  return {
    minRatio: readNumber('spendMonitorMarginMinRatio', settings),
    windowHours: readNumber('spendMonitorMarginWindowHours', settings),
    costFloorUsd: readNumber('spendMonitorMarginCostFloorUsd', settings),
  };
}

function readTrust(settings: SettingsMap): SpendTrustConfig {
  return parseSpendTrustConfig(
    getSettingsValue('spendMonitorTrustedEmailDomains', settings) ?? '',
    getSettingsValue('spendMonitorTrustedAccountIds', settings) ?? ''
  );
}

function readAutoPauseConfig(settings: SettingsMap): AutoPauseConfig {
  const read = (
    key:
      | 'spendMonitorAutoPauseStandardMinCredits'
      | 'spendMonitorAutoPausePaidMinCredits'
      | 'spendMonitorAutoPauseTrustedMinCredits'
  ): number => {
    const value = getSettingsValue(key, settings);
    if (value === undefined) throw new Error(`Setting ${key} resolved to no value`);
    return value;
  };
  const mode = getSettingsValue('spendMonitorAutoPauseMode', settings);
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
    throw new Error(`Setting spendMonitorAutoPauseMode resolved to an unknown mode: ${String(mode)}`);
  }
  return {
    mode,
    minCreditsByTier: {
      standard: read('spendMonitorAutoPauseStandardMinCredits'),
      paid: read('spendMonitorAutoPausePaidMinCredits'),
      trusted: read('spendMonitorAutoPauseTrustedMinCredits'),
    },
  };
}

const AUTO_PAUSE_AUDIT = {
  actor: systemAuditActor('spend-monitor-auto-pause'),
  context: { source: 'worker' as const, route: 'cron/spendMonitor' },
};

/** Freezes as the automatic actor; the freeze and its audit entry commit together. */
const autoPauseFreeze =
  (now: Date, logger: ILogger): AutoPauseDeps['freeze'] =>
  async ({ scope, rule, spendAlertId, reason }) => {
    const { freeze } = await withTransaction(() =>
      spendFreezeService.freezeSpend(
        { scope, actor: { kind: 'automatic', rule, spendAlertId }, reason, audit: AUTO_PAUSE_AUDIT, now },
        { db: { spendFreezes: spendFreezeRepository, adminAuditLog: adminAuditLogRepository }, logger }
      )
    );
    const byThisIncident = freeze.actor.kind === 'automatic' && freeze.actor.spendAlertId === spendAlertId;
    return { freezeId: freeze.id, byThisIncident };
  };

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
  const firstUnrolled = latestRolled && new Date(latestRolled.getTime() + SPEND_BUCKET_MS);
  if (firstUnrolled && buckets.length > 0 && buckets[0] > firstUnrolled) {
    logger.warn('spend-monitor-gap-skipped', {
      from: firstUnrolled.toISOString(),
      to: buckets[0].toISOString(),
      repair: 'pnpm --filter @bike4mind/scripts backfill:spend-rollups',
    });
  }
  // Sequential, oldest first: a failure leaves a contiguous rolled prefix for the next run to extend.
  for (const bucketStart of buckets) {
    const { docs } = await spendRollupRepository.rollupBucket(bucketStart);
    logger.log('spend-monitor-rolled', { bucketStart: bucketStart.toISOString(), docs });
  }

  const slackEnabled = getSettingsValue('spendMonitorSlackEnabled', settings) ?? false;
  const webhookUrl = resolveAlarmWebhookUrl(Resource, 'cost');
  const post = createSpendPost(slackEnabled, message => postAlarmToSlack(webhookUrl, message), logger);
  const { breaches, posted } = await evaluateSpend(
    now,
    {
      rollups: spendRollupRepository,
      alerts: spendAlertRepository,
      resolveScopeDeps: defaultResolveScopeDeps(),
      paidScopeDeps: defaultPaidScopeDeps(),
      accountContextDeps: defaultAccountContextDeps(),
      topAccountContextDeps: defaultTopAccountContextDeps(),
      post,
      messageContext: {
        creditUsd: MIN_PRICE_PER_CREDIT_USD,
        stage: Resource.App.stage,
        appUrl: appUrlFromEnv(),
        mention: await readAlarmMention(),
      },
      logger,
    },
    readThresholds(settings),
    readTrust(settings)
  );
  logger.log('spend-monitor-evaluated', { breaches, posted });

  // After evaluateSpend, so incidents opened or escalated by this run are paused in the same run.
  // A failure is rethrown only after the margin check, so it still fails the run without skipping it.
  let autoPauseFailure: unknown;
  try {
    const autoPause = await runAutoPause(
      now,
      {
        alerts: spendAlertRepository,
        freeze: autoPauseFreeze(now, logger),
        post,
        adminUrl: `${appUrlFromEnv()}/admin?tab=spend-monitor`,
        logger,
      },
      readAutoPauseConfig(settings)
    );
    logger.log('spend-monitor-auto-pause-evaluated', autoPause);
  } catch (error) {
    autoPauseFailure = error;
  }

  if (isMarginCheckSlot(now) && getSettingsValue('spendMonitorMarginEnabled', settings)) {
    const marginThresholds = readMarginThresholds(settings);
    try {
      const margin = await runMarginCheck(
        {
          rollups: spendRollupRepository,
          post,
          messageContext: { creditUsd: MIN_PRICE_PER_CREDIT_USD, stage: Resource.App.stage },
          logger,
        },
        marginThresholds
      );
      logger.log('spend-monitor-margin-evaluated', margin);
    } catch (error) {
      logger.error('spend-monitor-margin-failed', { error });
    }
  }
  if (autoPauseFailure !== undefined) throw autoPauseFailure;
  return { status: 'ok', rolled: buckets.length };
}
