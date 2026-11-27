import type { Logger } from '@bike4mind/observability';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { runQueuedFunctionCall } from '@bike4mind/server-utils/callableFunctions/asyncCalls';
import type { SQSEvent } from 'aws-lambda';
import { z } from 'zod';

/** callableFunctionCallQueue: runs one asynchronous function call queued by POST /api/v1/functions/{id}/invoke. */

const Job = z.object({ callId: z.string().regex(/^[0-9a-f]{24}$/) }).strict();

export async function handleCallableFunctionCallRecords(event: SQSEvent, logger: Logger): Promise<void> {
  for (const record of event.Records) {
    let body: unknown;
    try {
      body = JSON.parse(record.body);
    } catch {
      body = undefined;
    }
    const job = Job.safeParse(body);
    if (!job.success) {
      // Retrying cannot fix a malformed job, and it holds nothing a person is waiting on by id.
      logger.warn('Dropped a malformed callable function job', { messageId: record.messageId });
      continue;
    }
    const call = await runQueuedFunctionCall(job.data);
    logger.info('Callable function job', {
      callId: job.data.callId,
      outcome: call ? call.outcome : 'claimed_elsewhere_or_cancelled',
      ...(call?.reason ? { reason: call.reason } : {}),
    });
  }
}

export const dispatch = dispatchWithLogger(async (event, _context, logger) =>
  handleCallableFunctionCallRecords(event, logger)
);
