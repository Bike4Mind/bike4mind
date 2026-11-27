import type { DlqTriageEvidence } from '@bike4mind/common';
import type { IDlqFailure } from '@bike4mind/database';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  messageLogWindow,
  resolveConsumerLogs,
  settleWithinBudget,
} from '@bike4mind/server-utils/utils/dlqConsumerLogs';

export async function sampleDlqConsumerLogs(
  sourceQueueUrl: string | null | undefined,
  messageId: string,
  sentTimestamp?: string,
  deadline?: number
): Promise<DlqTriageEvidence['logFallback']> {
  const unavailable = { status: 'unavailable', sampledEvents: 0 } as const;
  // Only SQS-generated UUIDs may enter the log filter; never use message body text.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) return unavailable;
  if (!sourceQueueUrl) return unavailable;
  const budgetMs = deadline === undefined ? 500 : Math.min(500, deadline - Date.now());
  if (budgetMs <= 0) return unavailable;
  try {
    const [logs] = await settleWithinBudget([resolveConsumerLogs(sourceQueueUrl)], budgetMs);
    if (!logs || logs.logGroups.length !== 1 || !sentTimestamp?.trim()) return unavailable;
    const window = messageLogWindow(Number(sentTimestamp), logs.retryWindowMs);
    if (!window) return unavailable;
    const remainingMs = deadline === undefined ? 500 : Math.min(500, deadline - Date.now());
    if (remainingMs <= 0) return unavailable;
    const response = await new CloudWatchLogsClient({ region: logs.region, maxAttempts: 1 }).send(
      new FilterLogEventsCommand({
        logGroupName: logs.logGroups[0],
        filterPattern: `"${messageId}"`,
        startTime: window.start,
        endTime: window.end,
        limit: 20,
      }),
      { abortSignal: AbortSignal.timeout(remainingMs) }
    );
    const sampledEvents = Math.min(20, response.events?.length ?? 0);
    return { status: sampledEvents ? 'sampled-matches' : 'no-sampled-match', sampledEvents };
  } catch {
    return unavailable;
  }
}

export function buildDlqTriageEvidence(input: {
  failure?: IDlqFailure;
  sentTimestamp?: string;
  retentionSeconds?: number;
  entityPresent?: boolean;
  owner?: string;
  logFallback: DlqTriageEvidence['logFallback'];
  now?: number;
}): DlqTriageEvidence {
  const now = input.now ?? Date.now();
  const sent = input.sentTimestamp?.trim() ? Number(input.sentTimestamp) : NaN;
  const retention = input.retentionSeconds;
  const expires =
    Number.isFinite(sent) &&
    sent > 0 &&
    sent <= now &&
    retention !== undefined &&
    Number.isFinite(retention) &&
    retention > 0 &&
    retention <= 14 * 86400
      ? sent + retention * 1000
      : NaN;
  const knownExpiry = Number.isFinite(expires) && Number.isFinite(new Date(expires).getTime());
  // $LATEST is mutable and cannot identify the code that failed.
  const version = input.failure?.consumerVersion;
  const consumerVersion = version && /^[1-9][0-9]{0,9}$/.test(version) ? version : 'unknown';
  const category = input.failure?.category ?? 'unknown';
  return {
    coverage: 'partial-sqs-sample',
    failureSource: input.failure ? 'recorded' : 'unavailable',
    failureCategory: category,
    failedAt:
      input.failure?.failedAt && Number.isFinite(input.failure.failedAt.getTime())
        ? input.failure.failedAt.toISOString()
        : null,
    sentTimestamp: Number.isFinite(sent) && sent > 0 && sent <= now ? String(sent) : null,
    retentionSeconds: knownExpiry ? retention : null,
    consumerVersion,
    fixVerification: 'unavailable',
    entityContext: input.entityPresent ? 'present-id-withheld' : 'unavailable',
    owner: input.owner ?? null,
    expiry: {
      status: !knownExpiry
        ? 'unavailable'
        : expires <= now
          ? 'elapsed'
          : expires - now <= 86400000
            ? 'within-24-hours'
            : 'outside-24-hours',
      estimatedExpiresAt: knownExpiry ? new Date(expires).toISOString() : null,
      explanation: knownExpiry
        ? 'Estimate from SQS sent time plus DLQ retention. Queue type and time before redrive can affect actual expiry; this is not a delivery guarantee.'
        : 'Age/expiry unavailable: a valid sent time and retention period are required.',
    },
    logFallback: input.logFallback,
    issueDraft:
      category === 'bug'
        ? {
            title: 'Investigate a recorded dead-letter consumer failure',
            body: `Recorded category: bug. Immutable consumer version: ${consumerVersion}. Fix relationship: unavailable. Coverage: partial SQS sample. Confirm the same deployed consumer version and a merged/deployed fix before replay. No message bodies, raw errors, entity IDs or logs are included.`,
          }
        : null,
  };
}

export function refreshDlqExpiry(evidence: DlqTriageEvidence, now = Date.now()): DlqTriageEvidence {
  const expires = evidence.expiry.estimatedExpiresAt ? Date.parse(evidence.expiry.estimatedExpiresAt) : NaN;
  return {
    ...evidence,
    expiry: {
      ...evidence.expiry,
      status: !Number.isFinite(expires)
        ? 'unavailable'
        : expires <= now
          ? 'elapsed'
          : expires - now <= 86400000
            ? 'within-24-hours'
            : 'outside-24-hours',
    },
  };
}
