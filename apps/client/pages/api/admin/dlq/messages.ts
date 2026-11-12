import { ApiKeyScope, meetsAdminPermissionRequirement } from '@bike4mind/common';
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
import { dlqFailureRepository } from '@bike4mind/database';
import { z } from 'zod';

// Short polling samples a subset of SQS servers and can return empty for a sparse queue; a brief wait queries them all.
const RECEIVE_WAIT_SECONDS = 2;

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
 * Peeks at messages in a specific DLQ. Callers who can replay get a
 * 120-second visibility timeout so their receipt handles stay valid while
 * they decide. Read-only callers cannot replay, so their peek leaves the
 * messages visible and returns no receipt handles. Each message carries a Logs Insights link
 * over its consumer's logs around its send time (null when either is unknown).
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

  const canReplay = meetsAdminPermissionRequirement(req.user, 'settings:manage');
  const [received, consumerLogs] = await Promise.all([
    receiveFromQueue(dlqUrl, maxMessages, canReplay ? 120 : 0, RECEIVE_WAIT_SECONDS),
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
  const { failures, lookupFailed } = await findFailures(
    queueLabel,
    dlqEntry.sourceQueue,
    messages.map(msg => msg.MessageId!)
  );
  const failureById = new Map(failures.map(failure => [failure.messageId, failure]));

  const formatted = messages.map(msg => {
    const failure = failureById.get(msg.MessageId!);
    return {
      messageId: msg.MessageId,
      body: msg.Body,
      receiptHandle: canReplay ? msg.ReceiptHandle : undefined,
      sentTimestamp: msg.Attributes?.SentTimestamp,
      approximateReceiveCount: msg.Attributes?.ApproximateReceiveCount,
      approximateFirstReceiveTimestamp: msg.Attributes?.ApproximateFirstReceiveTimestamp,
      logsUrl: messageLogsUrl(consumerLogs, msg.Attributes?.SentTimestamp),
      ...(lookupFailed ? { failureLookupFailed: true } : {}),
      failure: failure ? { errorMessage: failure.errorMessage, category: failure.category } : undefined,
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
