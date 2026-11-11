import { ApiKeyScope, meetsAdminPermissionRequirement } from '@bike4mind/common';
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
 * Peeks at messages in a specific DLQ. Callers who can replay get a
 * 120-second visibility timeout so their receipt handles stay valid while
 * they decide. Read-only callers cannot replay, so their peek leaves the
 * messages visible and returns no receipt handles.
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
  const received = await receiveFromQueue(dlqUrl, maxMessages, canReplay ? 120 : 0);
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

  const formatted = messages.map(msg => ({
    messageId: msg.MessageId,
    body: msg.Body,
    receiptHandle: canReplay ? msg.ReceiptHandle : undefined,
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
