import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';

/**
 * Create a fresh SQS client on each call to ensure fresh AWS credentials.
 * Lambda containers can stay warm for extended periods (>15-60 min), causing
 * module-level clients to capture expired credentials. This pattern prevents
 * production failures: "InvalidSignatureException: Signature expired"
 */
const createSqsClient = () => new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });

export interface BatchSendResult {
  index: number;
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send messages in batches of 10 (AWS SendMessageBatch limit).
 * Inspects the Failed[] array and retries transient failures (SenderFault: false) once.
 * Per-message Id is encoded as `${chunkIdx}-${localIdx}` so caller-index reconstruction
 * is exact: originalIndex = chunkIdx * 10 + localIdx.
 */
export const sendBatchToQueue = async (
  queueUrl: string,
  messages: Record<string, unknown>[]
): Promise<BatchSendResult[]> => {
  const sqs = createSqsClient();
  const results: BatchSendResult[] = [];

  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < messages.length; i += 10) {
    chunks.push(messages.slice(i, i + 10));
  }

  await Promise.all(
    chunks.map(async (chunk, chunkIdx) => {
      const entries = chunk.map((msg, localIdx) => ({
        Id: `${chunkIdx}-${localIdx}`,
        MessageBody: JSON.stringify(msg),
      }));

      const response = await sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));

      // Record successes
      for (const s of response.Successful ?? []) {
        const [ci, li] = s.Id!.split('-').map(Number);
        results.push({ index: ci * 10 + li, success: true, messageId: s.MessageId });
      }

      // Retry transient failures (SenderFault: false) once
      const transient = (response.Failed ?? []).filter(f => !f.SenderFault);
      const permanent = (response.Failed ?? []).filter(f => f.SenderFault);

      for (const f of permanent) {
        const [ci, li] = f.Id!.split('-').map(Number);
        results.push({ index: ci * 10 + li, success: false, error: `${f.Code}: ${f.Message}` });
      }

      if (transient.length > 0) {
        const retryEntries = transient.map(f => ({
          Id: f.Id!,
          MessageBody: entries.find(e => e.Id === f.Id)!.MessageBody,
        }));

        const retryResponse = await sqs.send(
          new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: retryEntries })
        );

        for (const s of retryResponse.Successful ?? []) {
          const [ci, li] = s.Id!.split('-').map(Number);
          results.push({ index: ci * 10 + li, success: true, messageId: s.MessageId });
        }
        for (const f of retryResponse.Failed ?? []) {
          const [ci, li] = f.Id!.split('-').map(Number);
          results.push({ index: ci * 10 + li, success: false, error: `${f.Code}: ${f.Message}` });
        }
      }
    })
  );

  return results;
};

export const sendToQueue = async (queueUrl: string, message: Record<string, unknown>) => {
  const sqs = createSqsClient();

  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
  });
  const response = await sqs.send(command);
  return response.MessageId;
};

/**
 * Receive messages from an SQS queue without deleting them.
 * Messages become invisible for `visibilityTimeout` seconds.
 *
 * `waitTimeSeconds` defaults to 0 (short polling, immediate response) to preserve
 * existing callers. Pass up to 20 for long polling - used by the self-host worker's
 * poller loop (server/worker/selfHostWorker.ts) so it blocks instead of busy-spinning.
 */
export const receiveFromQueue = async (
  queueUrl: string,
  maxMessages: number,
  visibilityTimeout = 30,
  waitTimeSeconds = 0
): Promise<Message[]> => {
  const sqs = createSqsClient();
  const command = new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: Math.min(Math.max(maxMessages, 1), 10),
    WaitTimeSeconds: Math.min(Math.max(waitTimeSeconds, 0), 20),
    VisibilityTimeout: visibilityTimeout,
    AttributeNames: ['All'],
  });
  const response = await sqs.send(command);
  return response.Messages ?? [];
};

/**
 * Delete a message from an SQS queue using its receipt handle.
 */
export const deleteFromQueue = async (queueUrl: string, receiptHandle: string): Promise<void> => {
  const sqs = createSqsClient();
  const command = new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
  });
  await sqs.send(command);
};

/**
 * Get approximate message count and other attributes from an SQS queue.
 */
export const getQueueAttributes = async (
  queueUrl: string
): Promise<{ approximateMessageCount: number; approximateNotVisibleCount: number }> => {
  const sqs = createSqsClient();
  const command = new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  });
  const response = await sqs.send(command);
  return {
    approximateMessageCount: parseInt(response.Attributes?.ApproximateNumberOfMessages ?? '0', 10),
    approximateNotVisibleCount: parseInt(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10),
  };
};
