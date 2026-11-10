import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqByLabel, getDlqUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { receiveFromQueue } from '@bike4mind/server-utils/utils/sqs';
import { Logger } from '@bike4mind/observability';
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

/**
 * GET /api/admin/dlq/messages?queue=<label>&maxMessages=10
 *
 * Peeks at messages in a specific DLQ with VisibilityTimeout 0 so
 * browsing never hides messages from other admins or inflates the
 * ApproximateReceiveCount counter.
 */
const handler = adminApi({
  adminPermissions: { GET: 'settings:manage' },
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

  const messages = await receiveFromQueue(dlqUrl, maxMessages, 0);

  // receiptHandle is omitted: with VisibilityTimeout 0 the handle expires immediately,
  // so the frontend uses the messageIds replay path which receives with its own timeout.
  const formatted = messages.map(msg => ({
    messageId: msg.MessageId,
    body: msg.Body,
    sentTimestamp: msg.Attributes?.SentTimestamp,
    approximateReceiveCount: msg.Attributes?.ApproximateReceiveCount,
    approximateFirstReceiveTimestamp: msg.Attributes?.ApproximateFirstReceiveTimestamp,
  }));

  Logger.info(`[DLQ Messages] Returned ${formatted.length} messages from ${queueLabel}`, { adminUserId });

  return res.json({ messages: formatted, queueLabel });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
