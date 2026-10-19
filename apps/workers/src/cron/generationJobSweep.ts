/**
 * Re-enqueues generation jobs whose SQS message was lost or whose worker died mid-step.
 * Schedule: rate(5 minutes) on production and dev (infra/cron.ts generationJobSweep).
 * Self-host equivalent: apps/workers/src/selfhost/generationJobSweep.ts.
 */
import { connectDB, generationJobRepository } from '@bike4mind/database';
import { runGenerationJobSweep } from '@bike4mind/services/generationJobs';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { enqueueGenerationJob } from '@server/generationJobs/wiring';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'generationJobSweep' } });

export async function runGenerationJobSweepCron(): Promise<{ requeued: number }> {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runGenerationJobSweep({
    repository: generationJobRepository,
    enqueue: enqueueGenerationJob,
    now: () => new Date(),
    logger,
  });
}

export const handler = async () => runGenerationJobSweepCron();
