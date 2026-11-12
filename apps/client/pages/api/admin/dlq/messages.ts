import { ApiKeyScope, recommendDlqAction } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import {
  getDlqByLabel,
  getDlqUrl,
  getSourceQueueUrl,
  type SourceQueueName,
} from '@bike4mind/server-utils/utils/dlqRegistry';
import {
  buildLogsInsightsUrl,
  CONSUMER_LOGS_BUDGET_MS,
  messageLogWindow,
  resolveConsumerLogsForSourceQueue,
  settleWithinBudget,
  type ConsumerLogs,
} from '@bike4mind/server-utils/utils/dlqConsumerLogs';
import { receiveFromQueue } from '@bike4mind/server-utils/utils/sqs';
import { Logger } from '@bike4mind/observability';
import { dlqFailureRepository, dlqReplayLogRepository } from '@bike4mind/database';
import { z } from 'zod';

const QuerySchema = z.object({
  queue: z.string().min(1, 'queue label is required'),
  maxMessages: z
    .string()
    .optional()
    .transform(val => {
      const parsed = val ? parseInt(val, 10) : 10;
      return Math.min(Math.max(parsed, 1), 10);
    }),
});

function messageLogsUrl(logs: ConsumerLogs | null, sentTimestamp: string | undefined): string | null {
  if (!logs || !sentTimestamp) return null;
  const window = messageLogWindow(parseInt(sentTimestamp, 10), logs.retryWindowMs);
  return window ? buildLogsInsightsUrl({ region: logs.region, logGroups: logs.logGroups, ...window }) : null;
}

async function findFailures(queueLabel: string, sourceQueue: SourceQueueName | null, messageIds: string[]) {
  if (!sourceQueue || !messageIds.length) return { failures: [], lookupFailed: false };
  try {
    const sourceQueueName = new URL(getSourceQueueUrl(sourceQueue)).pathname.split('/').pop();
    if (!sourceQueueName) return { failures: [], lookupFailed: false };
    const failures = await dlqFailureRepository.findForMessages(sourceQueueName, messageIds);
    return { failures, lookupFailed: false };
  } catch (error) {
    Logger.warn('[DLQ Messages] Failure details unavailable', {
      queueLabel,
      errorName: error instanceof Error ? error.name : 'Unknown',
    });
    return { failures: [], lookupFailed: true };
  }
}

/**
 * GET /api/admin/dlq/messages?queue=<label>&maxMessages=10
 *
 * Receives messages with immediate visibility so browsing does not hide them from other admins.
 * SQS still increments ApproximateReceiveCount for these receives.
 * Each message carries a Logs Insights link over its consumer's logs around its send time
 * (null when either is unknown).
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const result = QuerySchema.safeParse(req.query);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid query parameters');
  }

  const { queue: queueLabel, maxMessages } = result.data;

  const dlqEntry = getDlqByLabel(queueLabel);
  if (!dlqEntry) {
    throw new BadRequestError(`Unknown DLQ: ${queueLabel}`);
  }

  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');
  const dlqUrl = getDlqUrl(dlqEntry.label);

  Logger.info(`[DLQ Messages] Peeking at ${queueLabel}`, { adminUserId, maxMessages });

  const [received, consumerLogs] = await Promise.all([
    receiveFromQueue(dlqUrl, maxMessages, 0),
    settleWithinBudget([resolveConsumerLogsForSourceQueue(dlqEntry.sourceQueue)], CONSUMER_LOGS_BUDGET_MS).then(
      ([logs]) => logs
    ),
  ]);
  // A visibility-0 receive can return the same message more than once; keep the latest copy.
  const receiveCount = (msg: (typeof received)[number]) =>
    parseInt(msg.Attributes?.ApproximateReceiveCount ?? '0', 10) || 0;
  const byId = new Map<string, (typeof received)[number]>();
  for (const msg of received) {
    if (!msg.MessageId) continue;
    const existing = byId.get(msg.MessageId);
    if (!existing || receiveCount(msg) > receiveCount(existing)) byId.set(msg.MessageId, msg);
  }
  const messages = [...byId.values()];
  const [[failureLookup], attempts] = await Promise.all([
    settleWithinBudget(
      [
        findFailures(
          queueLabel,
          dlqEntry.sourceQueue,
          messages.map(message => message.MessageId!)
        ),
      ],
      CONSUMER_LOGS_BUDGET_MS
    ),
    settleWithinBudget(
      messages.map(async message => {
        try {
          return await dlqReplayLogRepository.countAttempts(message.MessageId!);
        } catch (error) {
          Logger.warn('[DLQ Messages] Replay attempts unavailable', {
            queueLabel,
            errorName: error instanceof Error ? error.name : 'Unknown',
          });
          return null;
        }
      }),
      CONSUMER_LOGS_BUDGET_MS
    ),
  ]);
  const { failures, lookupFailed } = failureLookup ?? { failures: [], lookupFailed: true };
  const failureById = new Map(failures.map(failure => [failure.messageId, failure]));

  // receiptHandle is omitted: with VisibilityTimeout 0 the handle expires immediately,
  // so the frontend uses the messageIds replay path which receives with its own timeout.
  const formatted = messages.map((msg, index) => {
    const failure = failureById.get(msg.MessageId!);
    return {
      messageId: msg.MessageId,
      body: msg.Body,
      sentTimestamp: msg.Attributes?.SentTimestamp,
      approximateReceiveCount: msg.Attributes?.ApproximateReceiveCount,
      approximateFirstReceiveTimestamp: msg.Attributes?.ApproximateFirstReceiveTimestamp,
      logsUrl: messageLogsUrl(consumerLogs, msg.Attributes?.SentTimestamp),
      ...(lookupFailed ? { failureLookupFailed: true } : {}),
      failure: failure ? { errorMessage: failure.errorMessage, category: failure.category } : undefined,
      recommendation: recommendDlqAction({
        category: failure?.category,
        errorType: failure?.errorType,
        failedAt: failure?.failedAt?.toISOString(),
        consumerDeployedAt: consumerLogs?.consumerDeployedAt,
        replayAttempts: attempts[index] ?? undefined,
        replaySafety: dlqEntry.replay,
      }),
    };
  });

  Logger.info(`[DLQ Messages] Returned ${formatted.length} messages from ${queueLabel}`, { adminUserId });

  return res.json({ messages: formatted, queueLabel });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
