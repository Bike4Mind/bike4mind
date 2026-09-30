import { questRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { SQSService } from '@bike4mind/utils';
import { Resource } from 'sst';
import type { GenerationCallbackMessage } from './messages';

/**
 * The delivery queue's url, or undefined where it is not provisioned: the queue is optional on a
 * self-hosted deployment (b4m-core/resource/src/manifest.ts), where callbacks are then refused at
 * request time (armGenerationCallback.ts) rather than armed and never sent.
 */
export function getGenerationCallbackQueueUrl(): string | undefined {
  // A direct link, not getSourceQueueUrl: the sourceQueueUrls map is linked to the web function
  // only, and this also runs in the generation queue Lambdas and the timeout sweep.
  return Resource.generationCallbackQueue?.url;
}

/**
 * Hand a settled quest's armed callback to the delivery queue, at most once.
 *
 * Every site that can settle a generation quest calls this: the three generation queue
 * handlers, the route that arms the callback (for a job that settled before it was armed), the
 * timeout recoveries (the poll route, check-timeout, and the questTimeoutSweep backstop), and a
 * user stop (stop-reply). The atomic claim in
 * claimCallbackDispatch makes all but the first call a no-op, and a quest with no callback, or
 * one not yet settled, never matches it.
 *
 * Never throws: every caller is finishing work that already succeeded. An enqueue failure is
 * logged and the claim released, which leaves the callback `pending` for the sweep backstop.
 */
export async function dispatchQuestCallback(questId: string, logger: Logger): Promise<void> {
  let claimedEventId: string | null = null;
  try {
    const queueUrl = getGenerationCallbackQueueUrl();
    // Nothing is armed without a queue (see getGenerationCallbackQueueUrl), so this only fires on
    // a deployment that dropped the queue after arming; leave the callback pending, not claimed.
    if (!queueUrl) {
      logger.warn('generationCallbackQueue not configured; leaving callback pending', { questId });
      return;
    }
    claimedEventId = await questRepository.claimCallbackDispatch(questId);
    if (!claimedEventId) return;

    const message: GenerationCallbackMessage = { questId };
    await new SQSService().sendMessage(queueUrl, message);
    logger.info('Generation callback dispatched', { questId });
  } catch (error) {
    logger.error('Failed to dispatch generation callback; the sweep will retry it', { questId, error });
    if (!claimedEventId) return;
    await questRepository
      .releaseCallbackDispatch(questId, claimedEventId)
      .catch(releaseError =>
        logger.error('Failed to release generation callback claim', { questId, error: releaseError })
      );
  }
}
