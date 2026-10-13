import { ChangeMessageVisibilityCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SelfHostWorker } from './selfHostWorker';

// Receive count and visibility must match notebookCurationQueue and questExportQueue in elasticmq.conf.
const MAX_RECEIVE_COUNT = 3;
const VISIBILITY_TIMEOUT_SECONDS = 900;
const RENEWAL_INTERVAL_MS = 60000;
const RUN_BUDGET_MS = 600000;

type Registration = Parameters<SelfHostWorker['registerQueueHandler']>;
interface RedrivenQueueOptions {
  name: string;
  label: string;
  queueUrl: string | undefined;
  deadLetterQueueUrl: string | undefined;
  dispatch: Registration[2];
}

export async function registerRedrivenQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  { name, label, queueUrl, deadLetterQueueUrl, dispatch }: RedrivenQueueOptions,
  logger: { warn: (message: string) => void; error: (message: string, error: unknown) => void }
): Promise<void> {
  if (!queueUrl) {
    logger.warn(`${name} not configured; ${label} is unavailable`);
    return;
  }
  const client = new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });
  try {
    if (!deadLetterQueueUrl) throw new Error(`${label} redrive requires a configured DLQ`);
    const [source, target] = await Promise.all([
      client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['RedrivePolicy'] })),
      client.send(new GetQueueAttributesCommand({ QueueUrl: deadLetterQueueUrl, AttributeNames: ['QueueArn'] })),
    ]);
    let policy: unknown;
    try {
      policy = JSON.parse(source.Attributes?.RedrivePolicy ?? 'null');
    } catch {
      throw new Error(`${label} redrive policy is invalid`);
    }
    if (
      !policy ||
      typeof policy !== 'object' ||
      !('maxReceiveCount' in policy) ||
      Number(policy.maxReceiveCount) !== MAX_RECEIVE_COUNT ||
      !('deadLetterTargetArn' in policy) ||
      !target.Attributes?.QueueArn ||
      policy.deadLetterTargetArn !== target.Attributes.QueueArn
    ) {
      throw new Error(`${label} redrive must target the configured DLQ after ${MAX_RECEIVE_COUNT} deliveries`);
    }
  } catch (error) {
    logger.error(`${label} consumer disabled: redrive verification failed`, error);
    return;
  }
  worker.registerQueueHandler(
    name,
    queueUrl,
    async (event, context) => {
      const receipt = event.Records[0]?.receiptHandle;
      if (!receipt) throw new Error(`${label} message has no receipt handle`);
      if (Number(event.Records[0]?.attributes?.ApproximateReceiveCount ?? 1) > MAX_RECEIVE_COUNT) {
        throw new Error(`${label} redrive did not retain an exhausted message; repair broker redrive before replay`);
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
              VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
            })
          )
          .then(() => {
            renewalError = undefined;
          })
          .catch(error => {
            renewalError = error;
          })
          .finally(() => {
            renewal = undefined;
          });
      }, RENEWAL_INTERVAL_MS);
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
    {
      batchSize: 1,
      visibilityTimeoutSec: VISIBILITY_TIMEOUT_SECONDS,
      runBudgetMs: RUN_BUDGET_MS,
      maxReceiveCount: Number.MAX_SAFE_INTEGER,
    }
  );
}
