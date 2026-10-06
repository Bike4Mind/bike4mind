import type { Context, SQSEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import { dispatch } from '@server/queueHandlers/dataLakeCleanup';
import { changeMessageVisibility } from '@server/utils/sqs';
import type { SelfHostWorker } from './selfHostWorker';

const VISIBILITY_SECONDS = 720;

export function registerDataLakeCleanupQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: Pick<Logger, 'warn'>
): void {
  if (!queueUrl) {
    logger.warn('dataLakeCleanupQueue not configured; permanent lake cleanup is unavailable');
    return;
  }
  worker.registerQueueHandler(
    'dataLakeCleanupQueue',
    queueUrl,
    async (event: SQSEvent, context: Context) => {
      const receipt = event.Records[0]?.receiptHandle;
      if (!receipt) throw new Error('Cleanup message has no receipt handle');
      let renewal: Promise<void> | undefined;
      let renewalError: unknown;
      // Cleanup is not deadline-aware. Renew the hosted 12-minute window rather than guessing its duration.
      const timer = setInterval(() => {
        if (renewal) return;
        renewal = changeMessageVisibility(queueUrl, receipt, VISIBILITY_SECONDS)
          .catch(error => {
            renewalError = error;
          })
          .finally(() => {
            renewal = undefined;
          });
      }, 60_000);
      try {
        const result = await dispatch(event, context);
        await renewal;
        if (renewalError) throw renewalError;
        return result;
      } finally {
        clearInterval(timer);
        await renewal;
      }
    },
    {
      batchSize: 1,
      visibilityTimeoutSec: VISIBILITY_SECONDS,
      // This queue has broker-managed redrive. Never discard an exhausted destructive operation locally.
      maxReceiveCount: Number.MAX_SAFE_INTEGER,
    }
  );
}
