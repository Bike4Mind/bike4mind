import { randomUUID } from 'crypto';
import { connectDB, AdminSettings } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';
import { sendToQueue } from '@server/utils/sqs';
import type { WhatsNewHighlightsPayload } from '@server/queueHandlers/whatsNewHighlights.types';

const logger = new Logger({ metadata: { service: 'whatsNewHighlightsCron' } });

const SETTING_NAME = 'whatsNewHighlightsConfig';

/**
 * Cron handler for generating weekly What's New highlights and posting to Slack.
 *
 * Only runs in production environment.
 * Respects the enabled config setting - if disabled, generation is skipped.
 *
 * Schedule: Weekly on Saturday at 2am CST (8:00 UTC)
 * Runs 1 hour after the daily What's New modal generation (7am UTC).
 */
export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  logger.info("Starting What's New weekly highlights generation", {
    stage,
    timestamp: new Date().toISOString(),
  });

  if (stage !== 'production') {
    logger.warn("Skipping What's New highlights - not in production environment", { stage });
    return { status: 'SKIPPED', reason: 'Not production environment' };
  }

  const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });
  const config = setting?.settingValue as
    | {
        enabled?: boolean;
        slackChannelId?: string;
        slackTeamId?: string;
      }
    | undefined;

  if (!config?.enabled) {
    logger.info("Skipping What's New highlights - not enabled in settings", { config });
    return { status: 'SKIPPED', reason: 'Highlights generation disabled in settings' };
  }

  if (!config.slackChannelId || !config.slackTeamId) {
    logger.warn("Skipping What's New highlights - Slack channel not configured", { config });
    return { status: 'SKIPPED', reason: 'Slack channel not configured' };
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);

  const correlationId = randomUUID();

  const payload: WhatsNewHighlightsPayload = {
    correlationId,
    environment: 'production',
    startDate: startDate.toISOString().split('T')[0], // YYYY-MM-DD
    endDate: endDate.toISOString().split('T')[0],
    slackChannelId: config.slackChannelId,
    slackTeamId: config.slackTeamId,
  };

  try {
    // Type assertion needed: SST types are generated after first deploy
    const queueUrl = (Resource as unknown as Record<string, { url: string }>).whatsNewHighlightsQueue.url;
    await sendToQueue(queueUrl, payload);

    logger.info("Dispatched What's New highlights generation to queue", {
      correlationId,
      startDate: payload.startDate,
      endDate: payload.endDate,
      slackChannelId: config.slackChannelId,
    });

    await AdminSettings.findOneAndUpdate(
      { settingName: SETTING_NAME },
      {
        $set: {
          'settingValue.lastRunAt': new Date().toISOString(),
          'settingValue.lastCorrelationId': correlationId,
        },
      },
      { upsert: true }
    );

    return {
      status: 'DISPATCHED',
      correlationId,
      dateRange: { startDate: payload.startDate, endDate: payload.endDate },
    };
  } catch (error) {
    logger.error("Failed to dispatch What's New highlights to queue", {
      error: error instanceof Error ? error.message : String(error),
      correlationId,
    });
    throw error;
  }
}
