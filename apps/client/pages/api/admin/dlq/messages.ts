import { ApiKeyScope, isFullAdmin } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqByLabel, getDlqUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import {
  CONSUMER_LOGS_BUDGET_MS,
  resolveConsumerLogsForSourceQueue,
  settleWithinBudget,
} from '@bike4mind/server-utils/utils/dlqConsumerLogs';
import {
  countDlqReplayAttempts,
  DLQ_BROWSE_MESSAGE_ATTRIBUTES,
  findDlqFailures,
  latestCopies,
} from '@bike4mind/server-utils/utils/dlqMessages';
import {
  resolveDlqScheduleFacts,
  resolveDlqTargetLogs,
  toDlqMessageRow,
} from '@bike4mind/server-utils/utils/dlqMessageRow';
import { getQueueAttributes, receiveFromQueue } from '@bike4mind/server-utils/utils/sqs';
import { Logger } from '@bike4mind/observability';
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

/**
 * GET /api/admin/dlq/messages?queue=<label>&maxMessages=10
 *
 * Receives messages with immediate visibility so browsing does not hide them from other admins.
 * SQS still increments ApproximateReceiveCount for these receives.
 * Each message carries a Logs Insights link (see messageLogsUrl in server-utils dlqMessages): the
 * consumer's, EventBridge TARGET_ARN's or schedule rule target's log group, filtered to the RequestID
 * when the message has one; null when no log group or send time is known.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const enrichmentDeadline = Date.now() + CONSUMER_LOGS_BUDGET_MS;
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

  const [received, consumerLogs, queueDepth] = await Promise.all([
    receiveFromQueue(dlqUrl, maxMessages, 0, RECEIVE_WAIT_SECONDS, DLQ_BROWSE_MESSAGE_ATTRIBUTES),
    settleWithinBudget(
      [resolveConsumerLogsForSourceQueue(dlqEntry.sourceQueue, enrichmentDeadline)],
      enrichmentDeadline - Date.now()
    ).then(([logs]) => logs),
    getQueueAttributes(dlqUrl).then(
      attributes => attributes.approximateMessageCount + attributes.approximateNotVisibleCount,
      () => undefined
    ),
  ]);
  const messages = latestCopies(received);
  const ids = messages.map(message => message.MessageId!);
  const [[failureLookup], [attempts], schedules, targetLogs] = await Promise.all([
    settleWithinBudget([findDlqFailures(queueLabel, dlqEntry.sourceQueue, ids)], CONSUMER_LOGS_BUDGET_MS),
    settleWithinBudget([countDlqReplayAttempts(queueLabel, ids)], CONSUMER_LOGS_BUDGET_MS),
    resolveDlqScheduleFacts(dlqEntry, messages, queueDepth, enrichmentDeadline),
    resolveDlqTargetLogs(messages, enrichmentDeadline),
  ]);
  const { failures, lookupFailed } = failureLookup ?? { failures: [], lookupFailed: true };
  const failureById = new Map(failures.map(failure => [failure.messageId, failure]));

  // receiptHandle is omitted: with VisibilityTimeout 0 the handle expires immediately,
  // so the frontend uses the messageIds replay path which receives with its own timeout.
  const formatted = messages.map(message =>
    toDlqMessageRow(dlqEntry, message, {
      recorded: failureById.get(message.MessageId!),
      lookupFailed,
      logs: consumerLogs,
      replayAttempts: attempts?.get(message.MessageId!),
      schedule: schedules.get(message.MessageId!),
      targetLogs: targetLogs.get(message.MessageId!),
      revealRestrictedBody: isFullAdmin(req.user),
    })
  );

  Logger.info(`[DLQ Messages] Returned ${formatted.length} messages from ${queueLabel}`, { adminUserId });

  return res.json({ messages: formatted, queueLabel });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
