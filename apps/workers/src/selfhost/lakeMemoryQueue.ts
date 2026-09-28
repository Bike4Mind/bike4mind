import type { Logger } from '@bike4mind/observability';
import { dispatch } from '@server/queueHandlers/lakeMemoryExtraction';
import type { SelfHostWorker } from './selfHostWorker';

export function registerLakeMemoryQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: Pick<Logger, 'warn'>
): void {
  if (!queueUrl) {
    logger.warn('lakeMemoryQueue not configured; lake memory extraction will not run');
    return;
  }
  worker.registerQueueHandler(
    'lakeMemoryQueue',
    queueUrl,
    (event, context) => {
      const startedAt = Date.now();
      return dispatch(event, {
        ...context,
        getRemainingTimeInMillis: () => Math.max(0, 600_000 - (Date.now() - startedAt)),
      });
    },
    {
      batchSize: 1,
      // A crashed extraction holds a 15-minute lease; retry must arrive after it expires.
      visibilityTimeoutSec: 960,
      maxReceiveCount: 2,
    }
  );
}
