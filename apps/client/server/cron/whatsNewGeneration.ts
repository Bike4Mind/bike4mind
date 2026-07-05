/**
 * What's New Modal Generation Cron Dispatcher
 *
 * Daily cron that collects merged PRs/commits from GitHub and dispatches
 * to the What's New generation SQS queue. Replaces the GitHub Actions workflow.
 *
 * Schedule: Daily at 7am UTC (1am CST)
 * Only runs in production environment.
 *
 * Uses GitHubService.forSystem() for GitHub API access (same as LiveOps triage).
 */

import { randomUUID } from 'crypto';
import { connectDB, AdminSettings } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';
import { sendToQueue } from '@server/utils/sqs';
import { collectDataForDate } from '@server/services/whatsNewDataCollector';
import type { WhatsNewGenerationPayload } from '@server/queueHandlers/types';

const logger = new Logger({ metadata: { service: 'whatsNewGenerationCron' } });

const GENERATION_STATUS_SETTING = 'whatsNewGenerationStatus';

/**
 * Cron handler for daily What's New modal generation.
 *
 * Only runs in production environment.
 * Collects PRs/commits from the previous day and dispatches to SQS.
 */
export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  logger.info("Starting What's New daily generation", {
    stage,
    timestamp: new Date().toISOString(),
  });

  if (stage !== 'production') {
    logger.warn("Skipping What's New generation - not in production environment", { stage });
    return { status: 'SKIPPED', reason: 'Not production environment' };
  }

  const configSetting = await AdminSettings.findOne({ settingName: 'whatsNewConfig' });
  const configValue = configSetting?.settingValue as Record<string, unknown> | undefined;
  const repository = (configValue?.repository as string) || 'MillionOnMars/lumina5';
  const targetBranch = (configValue?.targetBranch as string) || 'main';

  const todayUTC = new Date().toISOString().split('T')[0];
  const correlationId = randomUUID();

  logger.info('Collecting data for date', { targetDate: todayUTC, correlationId, repository, targetBranch });

  // collectDataForDate calls GitHubService.forSystem() which now throws for transient
  // failures (DB error, auth init). Catch here so the cron records a 'failed' status
  // in AdminSettings rather than crashing the Lambda silently - the next daily run will retry.
  let collectedData: Awaited<ReturnType<typeof collectDataForDate>>;
  try {
    collectedData = await collectDataForDate(todayUTC, logger, { repository, targetBranch });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Data collection failed - unexpected error', { error: errorMessage });

    await AdminSettings.findOneAndUpdate(
      { settingName: GENERATION_STATUS_SETTING },
      {
        $set: {
          'settingValue.lastStatus': 'failed',
          'settingValue.lastCompletedAt': new Date().toISOString(),
          'settingValue.lastCorrelationId': correlationId,
          'settingValue.lastError': errorMessage,
          'settingValue.lastGeneratedDate': todayUTC,
        },
      },
      { upsert: true }
    );

    return { status: 'FAILED', reason: errorMessage };
  }

  if (!collectedData) {
    logger.error('Data collection failed - GitHubService unavailable');

    await AdminSettings.findOneAndUpdate(
      { settingName: GENERATION_STATUS_SETTING },
      {
        $set: {
          'settingValue.lastStatus': 'failed',
          'settingValue.lastCompletedAt': new Date().toISOString(),
          'settingValue.lastCorrelationId': correlationId,
          'settingValue.lastError': 'GitHubService unavailable',
          'settingValue.lastGeneratedDate': todayUTC,
        },
      },
      { upsert: true }
    );

    return { status: 'FAILED', reason: 'GitHubService unavailable' };
  }

  // If no user-facing PRs, log and return (no need for SQS message)
  if (collectedData.filteredPRCount === 0) {
    logger.info('No user-facing PRs found for today, skipping queue dispatch', {
      rawPRCount: collectedData.rawPRCount,
      filteredPRCount: 0,
    });

    await AdminSettings.findOneAndUpdate(
      { settingName: GENERATION_STATUS_SETTING },
      {
        $set: {
          'settingValue.lastRunAt': new Date().toISOString(),
          'settingValue.lastCorrelationId': correlationId,
          'settingValue.lastGeneratedDate': todayUTC,
          'settingValue.lastStatus': 'no_prs',
        },
      },
      { upsert: true }
    );

    return { status: 'NO_PRS', date: todayUTC, rawPRCount: collectedData.rawPRCount };
  }

  const payload: WhatsNewGenerationPayload = {
    ...collectedData.payload,
    correlationId,
    environment: 'production',
  };

  try {
    // Type assertion needed: SST types are generated after first deploy
    const queueUrl = (Resource as unknown as Record<string, { url: string }>).whatsNewGenerationQueue.url;
    await sendToQueue(queueUrl, payload as unknown as Record<string, unknown>);

    logger.info("Dispatched What's New generation to queue", {
      correlationId,
      targetDate: todayUTC,
      prs: collectedData.filteredPRCount,
      commits: collectedData.commitCount,
    });

    await AdminSettings.findOneAndUpdate(
      { settingName: GENERATION_STATUS_SETTING },
      {
        $set: {
          'settingValue.lastRunAt': new Date().toISOString(),
          'settingValue.lastCorrelationId': correlationId,
          'settingValue.lastGeneratedDate': todayUTC,
        },
      },
      { upsert: true }
    );

    return {
      status: 'DISPATCHED',
      correlationId,
      date: todayUTC,
      prs: collectedData.filteredPRCount,
      commits: collectedData.commitCount,
    };
  } catch (error) {
    logger.error("Failed to dispatch What's New generation to queue", {
      error: error instanceof Error ? error.message : String(error),
      correlationId,
    });
    throw error;
  }
}
