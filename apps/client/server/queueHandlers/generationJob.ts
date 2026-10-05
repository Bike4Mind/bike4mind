import { z } from 'zod';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { getGenerationJobEngine } from '@server/generationJobs/wiring';

const GenerationJobMessageSchema = z.object({ jobId: z.string().min(1) });

type ParsedMessage = { success: true; data: { jobId: string } } | { success: false; reason: string };

const parseMessage = (rawBody: string): ParsedMessage => {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { success: false, reason: 'body is not valid JSON' };
  }
  const result = GenerationJobMessageSchema.safeParse(body);
  if (!result.success) return { success: false, reason: result.error.message };
  return { success: true, data: result.data };
};

/**
 * One engine step per message. A thrown error lets SQS redeliver; the engine's lease makes that safe.
 * A malformed message is dropped rather than thrown: redelivering it can never succeed.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const parsed = parseMessage(event.Records[0].body);
  if (!parsed.success) {
    logger.warn('generation job message malformed; dropping', {
      requestId: context.awsRequestId,
      reason: parsed.reason,
    });
    return;
  }
  const outcome = await getGenerationJobEngine().step(parsed.data.jobId);
  logger.debug('generation job step', { jobId: parsed.data.jobId, outcome });
});
