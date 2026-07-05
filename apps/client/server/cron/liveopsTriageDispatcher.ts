/**
 * LiveOps Triage Dispatcher
 *
 * Scheduled Lambda function that dispatches triage jobs to SQS for each enabled config.
 * This replaces the old single-config cron approach with a fan-out pattern.
 *
 * Schedule: Every 6 hours at 2am, 8am, 2pm, 8pm CST (8, 14, 20, 2 UTC)
 * For each enabled config where shouldRunAtCurrentHour(config.runIntervalHours) is true:
 * - Publishes SQS message with { configId, dispatchedAt }
 *
 * Graceful degradation: If one config fails to dispatch, continue with others.
 *
 * Environment: Production only (with fallback to dev for staging testing)
 */

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { connectDB, liveopsTriageConfigRepository, liveopsTriageConfigAuditLogRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';
import { shouldRunAtCurrentHour, getRunHoursForInterval } from '@client/shared/liveopsScheduleUtils';

const logger = new Logger({ metadata: { service: 'liveopsTriageDispatcher' } });

const CLOUDWATCH_NAMESPACE = 'Lumina5/LiveOpsTriage';

/**
 * SQS message schema for triage jobs
 */
export interface LiveOpsTriageJobMessage {
  /** Config ID to process */
  configId: string;
  /** Config name (for logging) */
  configName: string;
  /** Timestamp when dispatched (for idempotency) */
  dispatchedAt: number;
  /** Source of the job */
  source: 'cron' | 'manual';
  /** If true, runs in dry-run mode */
  dryRun?: boolean;
  /** Optional lookback hours for manual runs (defaults to config.runIntervalHours) */
  lookbackHours?: number;
}

function isAllowedEnvironment(): boolean {
  const stage = Resource.App.stage;
  // Only run in production and dev (staging uses the 'dev' stage name)
  const allowedStages = ['production', 'dev'];
  return allowedStages.includes(stage);
}

/**
 * Check if this is a fork environment.
 *
 * Fork detection uses the ENABLE_WHATS_NEW_DISTRIBUTION env var pattern.
 * Main production has ENABLE_WHATS_NEW_DISTRIBUTION=true set.
 * Fork production deployments do NOT have this set.
 */
function isForkEnvironment(): boolean {
  const stage = Resource.App.stage;

  // Only relevant for production stage - other stages (dev, staging, pr-*) are never forks
  if (stage !== 'production') {
    return false;
  }

  const isSourceEnvironment = process.env.ENABLE_WHATS_NEW_DISTRIBUTION === 'true';
  return !isSourceEnvironment;
}

export async function handler() {
  const stage = Resource.App.stage;
  const startTime = Date.now();
  const currentHourUTC = new Date().getUTCHours();

  logger.info('[LIVEOPS-DISPATCHER] Starting dispatch', {
    stage,
    currentHourUTC,
    timestamp: new Date().toISOString(),
  });

  if (!isAllowedEnvironment()) {
    logger.info('[LIVEOPS-DISPATCHER] Skipping - not in production environment', { stage });
    return { status: 'SKIPPED', reason: 'Non-production environment' };
  }

  if (isForkEnvironment()) {
    logger.info('[LIVEOPS-DISPATCHER] Skipping - fork environment detected');
    return { status: 'SKIPPED', reason: 'Fork environment' };
  }

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const enabledConfigs = await liveopsTriageConfigRepository.findEnabled();

  if (enabledConfigs.length === 0) {
    logger.info('[LIVEOPS-DISPATCHER] No enabled configs found');
    await emitMetric(CLOUDWATCH_NAMESPACE, 'ConfigsDispatched', 0, { Stage: stage }, StandardUnit.Count);
    return { status: 'SUCCESS', configsDispatched: 0, configsSkipped: 0 };
  }

  const sqsClient = new SQSClient({});
  const queueUrl = Resource.liveOpsTriageQueue.url;

  let dispatched = 0;
  let skipped = 0;
  const errors: Array<{ configId: string; configName: string; error: string }> = [];

  for (const config of enabledConfigs) {
    try {
      if (!shouldRunAtCurrentHour(config.runIntervalHours)) {
        const scheduledHours = getRunHoursForInterval(config.runIntervalHours);
        logger.debug('[LIVEOPS-DISPATCHER] Skipping config - not scheduled for this hour', {
          configId: config.id,
          configName: config.name,
          intervalHours: config.runIntervalHours,
          currentHourUTC,
          scheduledHours,
        });
        skipped++;
        continue;
      }

      const message: LiveOpsTriageJobMessage = {
        configId: config.id,
        configName: config.name,
        dispatchedAt: Date.now(),
        source: 'cron',
      };

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
        })
      );

      logger.info('[LIVEOPS-DISPATCHER] Dispatched job for config', {
        configId: config.id,
        configName: config.name,
        intervalHours: config.runIntervalHours,
        issueTracker: config.issueTracker,
      });

      // SOC2 compliance: track cron-triggered runs
      await liveopsTriageConfigAuditLogRepository.createLog({
        configId: config.id,
        configName: config.name,
        action: 'trigger',
        userId: 'system',
        userName: 'cron-dispatcher',
        changes: {
          source: { old: null, new: 'cron' },
          scheduledHour: { old: null, new: currentHourUTC },
        },
      });

      dispatched++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[LIVEOPS-DISPATCHER] Failed to dispatch config', {
        configId: config.id,
        configName: config.name,
        error: errorMessage,
      });
      errors.push({
        configId: config.id,
        configName: config.name,
        error: errorMessage,
      });

      await emitMetric(
        CLOUDWATCH_NAMESPACE,
        'DispatchError',
        1,
        { Stage: stage, ConfigName: config.name },
        StandardUnit.Count
      );
    }
  }

  const duration = Date.now() - startTime;

  await Promise.all([
    emitMetric(CLOUDWATCH_NAMESPACE, 'ConfigsDispatched', dispatched, { Stage: stage }, StandardUnit.Count),
    emitMetric(
      CLOUDWATCH_NAMESPACE,
      'ConfigsSkipped',
      skipped,
      { Stage: stage, Reason: 'IntervalMismatch' },
      StandardUnit.Count
    ),
    emitMetric(CLOUDWATCH_NAMESPACE, 'DispatcherDuration', duration, { Stage: stage }, StandardUnit.Milliseconds),
  ]);

  logger.info('[LIVEOPS-DISPATCHER] Dispatch complete', {
    configsDispatched: dispatched,
    configsSkipped: skipped,
    errors: errors.length,
    durationMs: duration,
  });

  return {
    status: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
    configsDispatched: dispatched,
    configsSkipped: skipped,
    errors: errors.length > 0 ? errors : undefined,
  };
}
