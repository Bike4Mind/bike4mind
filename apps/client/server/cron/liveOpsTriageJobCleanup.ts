/**
 * LiveOps Triage Job Cleanup Cron
 *
 * Runs every 10 minutes to detect and fail stuck jobs.
 * A job is considered stuck if it's been 'processing' for longer than
 * the Lambda timeout (5 min) + visibility timeout (8 min) = 13 minutes.
 *
 * Schedule: Every 10 minutes
 * Environment: All stages
 */

import { connectDB, liveOpsTriageJobRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'liveOpsTriageJobCleanup' } });

// Lambda timeout (5 min) + visibility timeout (8 min) = 13 min
const STUCK_THRESHOLD_MINUTES = 13;

const CLOUDWATCH_NAMESPACE = 'Lumina5/LiveOpsTriage';

export async function handler() {
  const stage = Resource.App.stage;

  logger.info('Starting LiveOps Triage job cleanup', { stage });

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  try {
    const count = await liveOpsTriageJobRepository.markStuckJobsFailed(STUCK_THRESHOLD_MINUTES);

    if (count > 0) {
      logger.warn(`Marked ${count} stuck LiveOps Triage jobs as failed`, {
        count,
        thresholdMinutes: STUCK_THRESHOLD_MINUTES,
      });

      await emitMetric(CLOUDWATCH_NAMESPACE, 'StuckJobsDetected', count, { Stage: stage }, StandardUnit.Count);
    } else {
      logger.info('No stuck jobs found');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'success',
        stuckJobsFixed: count,
      }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('LiveOps Triage job cleanup failed', { error: errorMessage });

    await emitMetric(CLOUDWATCH_NAMESPACE, 'CleanupCronFailure', 1, { Stage: stage }, StandardUnit.Count);

    throw error;
  }
}
