import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';

/**
 * Asks the loop dispatch consumer (apps/workers/src/queueHandlers/loopDispatch.ts) to start the loop's next
 * run now rather than on the next scheduler tick. Best effort and awaited, like `pushLoopChanged`: callers
 * have already committed, the claim decides whether a run starts, and the tick is the fallback, so a
 * failure is logged, never thrown. `Resource` is read inside the try: stages without the loop scheduler and
 * the self-host executor have no queue link, and the read itself throws there.
 */
export async function requestLoopDispatch(loopId: string, logger: Logger): Promise<void> {
  try {
    await sendToQueue(Resource.loopDispatchQueue.url, { loopId });
  } catch (error) {
    logger.warn(`[Loops] Could not request a dispatch for loop ${loopId}`, { error });
  }
}

/**
 * Tells the owner's open loop page to refetch this loop (detail, tickets, events) after a change it did not
 * make itself: a run's write, the scheduler's fold or dispatch, the desktop runner. Must match the client's
 * `loopKeys.detail` (apps/client/app/hooks/data/loops.ts). Best effort; the page also polls.
 */
export async function pushLoopChanged(userId: string, loopId: string, logger: Logger): Promise<void> {
  try {
    await sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['loops', loopId],
    });
  } catch (error) {
    logger.warn(`[Loops] Could not push a change to loop ${loopId}`, { error });
  }
}
