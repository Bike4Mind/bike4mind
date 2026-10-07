import { connectDB, AdminSettings } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { WhatsNewSyncConfigSchema } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import { WhatsNewForkFetcher } from '@server/services/whatsNewForkFetcher';
import { getWhatsNewEnvInfo } from '@server/utils/whatsNewEnv';

const logger = new Logger({ metadata: { service: 'whatsNewSyncCron' } });

const SETTING_NAME = 'whatsNewSyncConfig';

/**
 * Cron handler for syncing What's New modals from production to fork environments.
 *
 * Only runs in non-source environments (dev, staging, fork production).
 * Source environment (main production with ENABLE_WHATS_NEW_DISTRIBUTION=true) generates modals.
 * Respects the autoSyncEnabled config setting - if disabled, sync is skipped.
 *
 * Default behavior based on environment type:
 * - Fork production: auto-sync OFF by default (opt-in for independent deployments)
 * - Staging/dev: auto-sync ON by default (same team, wants latest modals)
 *
 * Schedule: Daily at 9am UTC (3am CST) - 2 hours after production generates at 7am UTC (1am CST)
 */
export async function handler() {
  // Connect to DB first (needed for getWhatsNewEnvInfo which queries admin settings)
  // Use a preliminary stage for connection - this gets overwritten below if needed
  const preliminaryStage = process.env.SST_STAGE || 'dev';
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', preliminaryStage));

  const env = await getWhatsNewEnvInfo();

  logger.info("Starting What's New sync from production", {
    stage: env.stage,
    isSourceEnvironment: env.isSourceEnvironment,
    isForkProduction: env.isForkProduction,
    distributionUrlSource: env.distributionUrlSource,
  });

  // Never run in the source environment (main production) - it generates modals, not sync.
  if (env.isSourceEnvironment) {
    logger.warn("Skipping What's New sync - running in source environment (main production)");
    return { status: 'SKIPPED', reason: 'Source environment generates modals' };
  }

  const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });

  // If no setting exists, use the environment-appropriate default.
  const config = setting?.settingValue
    ? WhatsNewSyncConfigSchema.parse(setting.settingValue)
    : { autoSyncEnabled: env.defaultAutoSyncEnabled };

  if (!config.autoSyncEnabled) {
    logger.info("Skipping What's New sync - autoSyncEnabled is disabled", {
      config,
      isForkProduction: env.isForkProduction,
    });
    return { status: 'SKIPPED', reason: 'Auto-sync disabled in settings' };
  }

  try {
    // 1. Import new modals
    const importResult = await WhatsNewForkFetcher.fetchAndImportLatest();
    logger.info("What's New import completed", importResult);

    // 2. Sync existing modals (updates and deletions)
    const existingSync = await WhatsNewForkFetcher.syncExistingModals();
    logger.info("What's New existing modal sync completed", existingSync);

    await AdminSettings.findOneAndUpdate(
      { settingName: SETTING_NAME },
      {
        $set: {
          'settingValue.lastSyncAt': new Date().toISOString(),
          'settingValue.lastSyncResult': importResult.imported ? 'success' : 'skipped',
          'settingValue.lastSyncModalId': importResult.modalId,
          'settingValue.lastExistingSync': {
            updated: existingSync.updated,
            deleted: existingSync.deleted,
            upToDate: existingSync.upToDate,
          },
        },
      },
      { upsert: true }
    );

    return {
      status: importResult.imported ? 'IMPORTED' : 'SKIPPED',
      ...importResult,
      existingSync,
    };
  } catch (error) {
    await AdminSettings.findOneAndUpdate(
      { settingName: SETTING_NAME },
      {
        $set: {
          'settingValue.lastSyncAt': new Date().toISOString(),
          'settingValue.lastSyncResult': 'failed',
        },
      },
      { upsert: true }
    );

    // Error details already logged by WhatsNewForkFetcher; this just marks it as a scheduled-job failure.
    logger.error("What's New sync cron job failed - see service logs for details");
    throw error;
  }
}
