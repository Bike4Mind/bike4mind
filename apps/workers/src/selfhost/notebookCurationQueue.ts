import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { dispatch } from '@server/queueHandlers/notebookCuration';
import type { SelfHostWorker } from './selfHostWorker';

export function registerNotebookCurationQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: { warn: (message: string) => void }
): void {
  if (!queueUrl) {
    logger.warn('notebookCurationQueue not configured; notebook curation is unavailable');
    return;
  }
  worker.registerQueueHandler(
    'notebookCurationQueue',
    queueUrl,
    async (event, context) => {
      const receipt = event.Records[0]?.receiptHandle;
      if (!receipt) throw new Error('Notebook message has no receipt handle');
      const startedAt = Date.now();
      const client = new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });
      let renewal: Promise<void> | undefined;
      let renewalError: unknown;
      const timer = setInterval(() => {
        if (renewal) return;
        renewal = client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: receipt,
              VisibilityTimeout: 900,
            })
          )
          .then(() => undefined)
          .catch(error => {
            renewalError = error;
          })
          .finally(() => {
            renewal = undefined;
          });
      }, 60000);
      try {
        const result = await dispatch(event, {
          ...context,
          getRemainingTimeInMillis: () => Math.max(0, 600000 - (Date.now() - startedAt)),
        });
        clearInterval(timer);
        await renewal;
        if (renewalError) throw renewalError;
        return result;
      } finally {
        clearInterval(timer);
        await renewal;
      }
    },
    { batchSize: 1, visibilityTimeoutSec: 900, maxReceiveCount: Number.MAX_SAFE_INTEGER }
  );
}
