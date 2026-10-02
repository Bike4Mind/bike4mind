import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { connectDB, deepAgentHandoffRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';
import { sendToQueue } from '@server/utils/sqs';

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

/**
 * Lease pushed onto `nextWakeAt` at claim time so subsequent cron ticks can't
 * re-enqueue an agent whose wake is still in flight. Must exceed the queue's
 * visibility timeout (12 min) so a retried message still owns its lease.
 */
const WAKE_LEASE_MS = 15 * 60 * 1000;

/**
 * Deep Agent Wake Scheduler (cron dispatcher).
 *
 * Atomically CLAIMS agents whose next wake is due (`handoff.nextWakeAt <= now`)
 * - claiming pushes `nextWakeAt` forward by the lease, so concurrent ticks
 * cannot double-enqueue - then enqueues one wake job per agent onto
 * `deepAgentWakeQueue`. The wake handler runs orient -> act -> reflect -> groom.
 *
 * Note: an agent's FIRST wake is not scheduled here - it has no handoff until
 * it has woken once. Enrollment (seeding a charter) is responsible for enqueuing
 * the initial wake; thereafter `handoff.nextWakeIntervalMs` drives the cadence.
 */
export async function handler(_event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);

  try {
    const dueAgentIds = await deepAgentHandoffRepository.claimDueAgentIds(new Date(), WAKE_LEASE_MS);
    logger.info(`Claimed ${dueAgentIds.length} deep agent(s) due for a wake`);

    for (const agentId of dueAgentIds) {
      try {
        await sendToQueue(Resource.deepAgentWakeQueue.url, { agentId });
        logger.info(`Queued wake for deep agent ${agentId}`);
      } catch (error) {
        logger.error(`Error queueing wake for deep agent ${agentId}:`, error as Error);
        // Hand the claim back - otherwise a transient SQS failure stalls this
        // agent until the full lease expires (~15 min).
        try {
          await deepAgentHandoffRepository.releaseWakeClaim(agentId, new Date());
          logger.info(`Released wake claim for deep agent ${agentId} (will retry next tick)`);
        } catch (releaseError) {
          logger.error(`Failed to release wake claim for ${agentId}:`, releaseError as Error);
        }
      }
    }

    logger.info('Finished queueing deep agent wakes');
  } catch (error) {
    logger.error('Error in deepAgentWake cron handler:', error as Error);
    throw error;
  }
}
