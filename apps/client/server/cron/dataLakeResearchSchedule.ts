/**
 * Data Lake Research Schedule
 *
 * Fires every saved research configuration whose cadence has come due: counts the lake's pending
 * proposals, skips the run while the review queue is at the config's limit, otherwise starts and
 * queues it exactly as Run now does. The decision logic lives in
 * `dataLakeResearchService.runDueResearchSchedules`; this file only binds it to Mongo and SQS.
 *
 * runResearchScheduleTick is also the self-host worker's counterpart (worker/main.ts) - self-host
 * has no SST cron, so it drives the same tick off its own scheduled-task interval.
 *
 * Schedule: every 15 minutes (infra/cron.ts). Enabled: production + dev.
 */

import { settingsMap } from '@bike4mind/common';
import {
  adminSettingsRepository,
  connectDB,
  dataLakeProposalRepository,
  dataLakeResearchConfigRepository,
  dataLakeResearchRunRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { dataLakeResearchService } from '@bike4mind/services';
import { getSettingByName } from '@bike4mind/utils';
import { Resource } from 'sst';
import { queueResearchRun } from '@server/dataLakes/queueResearchRun';
import { isSettingEnabled } from '@server/middlewares/featureFlag';
import { Config } from '@server/utils/config';

const logger = new Logger({ metadata: { service: 'dataLakeResearchSchedule' } });

export async function runResearchScheduleTick(
  runLogger: Logger
): Promise<dataLakeResearchService.ResearchScheduleTickSummary | null> {
  // The routes are gated on this flag; a scheduler that ignored it would keep spending on lakes an
  // operator has switched off. Nothing is claimed, so due configs fire once it is back on.
  const enabled = await getSettingByName('EnableDataLakes', { adminSettings: adminSettingsRepository });
  if (!isSettingEnabled(enabled ?? settingsMap.EnableDataLakes?.defaultValue)) {
    runLogger.info('[research-schedule] EnableDataLakes is off; not firing scheduled research runs');
    return null;
  }

  // Same reason Run now checks it first: without the queue a started run sits `queued` forever.
  const queueUrl = Resource.dataLakeResearchQueue?.url;
  if (!queueUrl) {
    runLogger.info('[research-schedule] dataLakeResearchQueue is not configured; not firing scheduled research runs');
    return null;
  }

  return dataLakeResearchService.runDueResearchSchedules({
    db: {
      dataLakeResearchConfigs: dataLakeResearchConfigRepository,
      dataLakeResearchRuns: dataLakeResearchRunRepository,
      dataLakeProposals: dataLakeProposalRepository,
    },
    enqueue: run => queueResearchRun(run, queueUrl),
    logger: runLogger,
  });
}

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  return runResearchScheduleTick(logger);
}
