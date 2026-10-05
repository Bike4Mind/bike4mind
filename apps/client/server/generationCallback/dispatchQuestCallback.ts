import { questRepository, type StaleCallbackDispatchCriteria } from '@bike4mind/database';
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
 * How long a claim stays `dispatched` before the sweep treats its queue message as lost. The
 * receive retries bound only the time after a message is first received, not how long it waits
 * behind a backlog (the consumer is concurrency-capped, and a slow webhook endpoint stalls it), so
 * a message still queued is indistinguishable from a lost one by age alone. A lost message is rare
 * and latency-insensitive, so the window is set far past any plausible backlog: re-enqueueing a
 * backlogged message would add load to the queue that is already behind.
 */
export const GENERATION_CALLBACK_STALE_DISPATCH_MS = 6 * 60 * 60 * 1000;

/**
 * Oldest claim the sweep will re-send. Without it, the first runs after deploy would deliver
 * completions weeks old to a caller that has long stopped waiting.
 */
export const GENERATION_CALLBACK_REDISPATCH_HORIZON_MS = 72 * 60 * 60 * 1000;

/**
 * Stale-dispatch reclaims allowed per arm. A message lost once is re-enqueued; one the handler
 * crashes on every receive (so it reaches the DLQ still `dispatched`) must not loop forever.
 */
export const GENERATION_CALLBACK_MAX_REDISPATCHES = 3;

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
  await enqueueClaimedCallback(questId, logger, () => questRepository.claimCallbackDispatch(questId));
}

/**
 * Re-enqueue a callback stuck at `dispatched` whose message was lost (see
 * reclaimStaleCallbackDispatch). Same never-throws and release-on-failure contract as
 * dispatchQuestCallback. Resolves true only when a message was actually sent.
 */
export async function redispatchStaleQuestCallback(
  questId: string,
  criteria: StaleCallbackDispatchCriteria,
  logger: Logger
): Promise<boolean> {
  return enqueueClaimedCallback(questId, logger, () => questRepository.reclaimStaleCallbackDispatch(questId, criteria));
}

async function enqueueClaimedCallback(
  questId: string,
  logger: Logger,
  claim: () => Promise<string | null>
): Promise<boolean> {
  let claimedEventId: string | null = null;
  try {
    const queueUrl = getGenerationCallbackQueueUrl();
    // Nothing is armed without a queue (see getGenerationCallbackQueueUrl), so this only fires on
    // a deployment that dropped the queue after arming; leave the callback as it is, not claimed.
    if (!queueUrl) {
      logger.warn('generationCallbackQueue not configured; leaving callback unclaimed', { questId });
      return false;
    }
    claimedEventId = await claim();
    if (!claimedEventId) return false;

    const message: GenerationCallbackMessage = { questId, eventId: claimedEventId };
    await new SQSService().sendMessage(queueUrl, message);
    logger.info('Generation callback dispatched', { questId });
    return true;
  } catch (error) {
    logger.error('Failed to dispatch generation callback; the sweep will retry it', { questId, error });
    if (!claimedEventId) return false;
    await questRepository
      .releaseCallbackDispatch(questId, claimedEventId)
      .catch(releaseError =>
        logger.error('Failed to release generation callback claim', { questId, error: releaseError })
      );
    return false;
  }
}
