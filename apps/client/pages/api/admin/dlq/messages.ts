import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, BadRequestError } from '@server/utils/errors';
import { getDlqByLabel, getDlqUrl } from '@server/utils/dlqRegistry';
import { receiveFromQueue } from '@server/utils/sqs';
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
 * Peeks at messages in a specific DLQ. Uses a 120-second visibility
 * timeout so that receipt handles remain valid while the admin reviews
 * and decides whether to replay individual messages.
 */
const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

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

  // Use 120s visibility timeout so receipt handles stay valid while the admin decides to replay
  const messages = await receiveFromQueue(dlqUrl, maxMessages, 120);

  const formatted = messages.map(msg => ({
    messageId: msg.MessageId,
    body: msg.Body,
    receiptHandle: msg.ReceiptHandle,
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
