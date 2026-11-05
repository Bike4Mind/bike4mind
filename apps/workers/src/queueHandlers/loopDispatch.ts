import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { z } from 'zod';
import { dispatchLoopNow } from '../cron/loopScheduler';

const messageSchema = z.object({ loopId: z.string().min(1) });

/**
 * loopDispatchQueue consumer: starts a loop's next run within seconds of the event that made it due (a ticket
 * moved, a run ended, Run now), instead of on the next scheduler tick. Senders: `requestLoopDispatch`
 * (apps/client/server/utils/loopDispatch.ts). Batch size 1 (infra/cron.ts), so a throw retries just this message.
 */
export const handler = dispatchWithLogger(async (event, _context, logger) => {
  for (const record of event.Records) {
    const parsed = messageSchema.safeParse(JSON.parse(record.body));
    if (!parsed.success) {
      logger.warn('[Loops] Dropping a malformed loop dispatch message', { body: record.body });
      continue;
    }
    await dispatchLoopNow(parsed.data.loopId, new Date(), logger);
  }
});
