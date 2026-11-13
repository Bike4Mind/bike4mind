import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { dlqFailureRepository, type DlqFailureCategory } from '@bike4mind/database';
import type { SQSEvent } from 'aws-lambda';
import { getDeliveryAttempt } from '../utils/sqsDelivery';
import { queueUrlFromArn } from '../utils/sqsRedelivery';

const policyCache = new Map<string, { count: number; expires: number }>();
const POLICY_CACHE_MS = 5 * 60 * 1000;

async function maxReceiveCount(arn: string): Promise<number | undefined> {
  const cached = policyCache.get(arn);
  if (cached && cached.expires > Date.now()) return cached.count;
  const queueUrl = queueUrlFromArn(arn);
  if (!queueUrl) return undefined;
  const region = arn.split(':')[3];
  const response = await new SQSClient({ region }).send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['RedrivePolicy'] })
  );
  const raw = response.Attributes?.RedrivePolicy;
  if (!raw) return undefined;
  const policy: unknown = JSON.parse(raw);
  if (!policy || typeof policy !== 'object' || !('maxReceiveCount' in policy)) return undefined;
  const count = Number(policy.maxReceiveCount);
  if (!Number.isInteger(count) || count < 1) return undefined;
  policyCache.set(arn, { count, expires: Date.now() + POLICY_CACHE_MS });
  return count;
}

export function failureCategory(errorType: string, message: string): DlqFailureCategory {
  const text = `${errorType} ${message}`;
  if (/refus|denied|forbidden|unauthoriz|insufficient credits/i.test(text)) return 'refused';
  if (/timeout|timed out|deadline|aborterror/i.test(text)) return 'timeout';
  if (/invalid (output|response)|malformed (output|response)|parse error|syntaxerror/i.test(text))
    return 'invalid output';
  return errorType === 'Error' || /error|exception/i.test(errorType) ? 'bug' : 'unknown';
}

export async function recordFinalDlqFailures(event: SQSEvent, error: unknown): Promise<void> {
  const record = event.Records[0];
  if (!record?.eventSourceARN) return;
  const limit = await maxReceiveCount(record.eventSourceARN);
  if (limit === undefined) return;

  const errorType = error instanceof Error ? error.name : 'Unknown';
  const errorMessage = error instanceof Error ? error.message : 'Non-Error thrown by consumer';
  const queueLabel = record.eventSourceARN.split(':').at(-1);
  if (!queueLabel) return;
  const failedAt = new Date();
  const consumerVersion = process.env.AWS_LAMBDA_FUNCTION_VERSION || 'unknown';
  await Promise.all(
    event.Records.filter(
      item =>
        item.messageId &&
        item.eventSourceARN === record.eventSourceARN &&
        (getDeliveryAttempt({ Records: [item] }) ?? 0) >= limit
    ).map(item =>
      dlqFailureRepository.record({
        queueLabel,
        messageId: item.messageId,
        errorType,
        errorMessage,
        category: failureCategory(errorType, errorMessage),
        failedAt,
        consumerVersion,
      })
    )
  );
}
