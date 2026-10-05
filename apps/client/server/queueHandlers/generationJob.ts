import { z } from 'zod';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { getGenerationJobEngine } from '@server/generationJobs/wiring';

const GenerationJobMessageSchema = z.object({ jobId: z.string().min(1) });

/**
 * One engine step per message. A thrown error lets SQS redeliver; the engine's lease makes that safe.
 * A malformed message is dropped rather than thrown: redelivering it can never succeed.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body: unknown = JSON.parse(event.Records[0].body);
  const parsed = GenerationJobMessageSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn('generation job message malformed; dropping', {
      requestId: context.awsRequestId,
      issues: parsed.error.issues,
    });
    return;
  }
  const outcome = await getGenerationJobEngine().step(parsed.data.jobId);
  logger.debug('generation job step', { jobId: parsed.data.jobId, outcome });
});
