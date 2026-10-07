import { ChangeMessageVisibilityCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { dispatch } from '@server/queueHandlers/questExport';
import type { SelfHostWorker } from './selfHostWorker';

export async function registerQuestExportQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: { warn: (message: string) => void; error: (message: string, error: unknown) => void }
): Promise<void> {
  if (!queueUrl) {
    logger.warn('questExportQueue not configured; quest export is unavailable');
    return;
  }
  const client = new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });
  try {
    const deadLetterQueueUrl = process.env.QUEST_EXPORT_QUEUE_DLQ;
    if (!deadLetterQueueUrl) throw new Error('Quest export redrive requires QUEST_EXPORT_QUEUE_DLQ');
    const [source, target] = await Promise.all([
      client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['RedrivePolicy'] })),
      client.send(new GetQueueAttributesCommand({ QueueUrl: deadLetterQueueUrl, AttributeNames: ['QueueArn'] })),
    ]);
    let policy: unknown;
    try {
      policy = JSON.parse(source.Attributes?.RedrivePolicy ?? 'null');
    } catch {
      throw new Error('Quest export redrive policy is invalid');
    }
    if (
      !policy ||
      typeof policy !== 'object' ||
      !('maxReceiveCount' in policy) ||
      Number(policy.maxReceiveCount) !== 3 ||
      !('deadLetterTargetArn' in policy) ||
      !target.Attributes?.QueueArn ||
      policy.deadLetterTargetArn !== target.Attributes.QueueArn
    ) {
      throw new Error('Quest export redrive must target the configured DLQ after three deliveries');
    }
  } catch (error) {
    logger.error('Quest export consumer disabled: redrive verification failed', error);
    return;
  }
  worker.registerQueueHandler(
    'questExportQueue',
    queueUrl,
    async (event, context) => {
      const receipt = event.Records[0]?.receiptHandle;
      if (!receipt) throw new Error('Quest export message has no receipt handle');
      if (Number(event.Records[0]?.attributes?.ApproximateReceiveCount ?? 1) > 3) {
        throw new Error(
          'Quest export redrive did not retain an exhausted message; repair broker redrive before replay'
        );
      }
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
        const result = await dispatch(event, context);
        clearInterval(timer);
        await renewal;
        if (renewalError) throw renewalError;
        return result;
      } finally {
        clearInterval(timer);
        await renewal;
      }
    },
    { batchSize: 1, visibilityTimeoutSec: 900, runBudgetMs: 600000, maxReceiveCount: Number.MAX_SAFE_INTEGER }
  );
}
