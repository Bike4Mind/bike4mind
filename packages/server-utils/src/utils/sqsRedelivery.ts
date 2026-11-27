import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { changeMessageVisibility } from './sqs';

/**
 * Queue URL for an SQS queue ARN (six colon-separated fields: `arn`, partition, service `sqs`, region,
 * account, queue name), or undefined for anything else
 * (the self-host worker hands its dispatch an empty eventSourceARN).
 */
export function queueUrlFromArn(arn: string | undefined): string | undefined {
  const parts = arn?.split(':') ?? [];
  if (parts.length !== 6 || parts[0] !== 'arn' || parts[2] !== 'sqs') return undefined;
  const [, , , region, account, name] = parts;
  if (!region || !account || !name) return undefined;
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}

/**
 * Hands a single-record delivery back to SQS for a later retry WITHOUT throwing, for transient
 * back-pressure (a saturated rate window) that is expected to clear on its own. Throwing out of the
 * Lambda logs an `Invoke Error` that pages; a partial-batch failure retries the same way, quietly.
 *
 * The record's visibility is first cut to `delaySeconds` plus up to `jitterSeconds` of random jitter,
 * so a herd of messages denied together does not redeliver together, and does not sit out the
 * queue's full visibility timeout either. That step is best-effort: if it fails (or the queue URL
 * cannot be derived) the message simply waits out the queue's own visibility timeout.
 *
 * The receive count still advances, so the queue's maxReceiveCount bounds the retries - the
 * caller must keep its final-attempt accounting (see deferFailureIfRetryable).
 *
 * Requires `batch: { partialResponses: true }` on the subscription (infra/queues.ts); without it
 * Lambda ignores the response and deletes the message. The self-host worker honours the same
 * response shape (apps/workers/src/selfhost/selfHostWorker.ts).
 */
export async function returnRecordForRedelivery(
  event: SQSEvent,
  params: { delaySeconds: number; jitterSeconds: number; logger: { warn: (msg: string) => void } }
): Promise<SQSBatchResponse> {
  const record = event.Records[0];
  // An empty failure list reads as success and deletes the message - never hand that back by accident.
  if (!record) throw new Error('returnRecordForRedelivery needs the delivery record');
  const { delaySeconds, jitterSeconds, logger } = params;
  // SQS caps a visibility timeout at 12 hours.
  const visibilitySeconds = Math.min(
    Math.max(0, Math.round(delaySeconds + Math.random() * Math.max(0, jitterSeconds))),
    43_200
  );
  const queueUrl = queueUrlFromArn(record.eventSourceARN);
  if (queueUrl && record.receiptHandle) {
    await changeMessageVisibility(queueUrl, record.receiptHandle, visibilitySeconds).catch(err =>
      logger.warn(`Could not shorten the redelivery delay (falls back to the queue visibility timeout): ${err}`)
    );
  }
  return { batchItemFailures: [{ itemIdentifier: record.messageId }] };
}
