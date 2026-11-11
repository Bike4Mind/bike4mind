import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqByLabel, getDlqUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { deleteFromQueue } from '@bike4mind/server-utils/utils/sqs';
import { dlqReplayLogRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const BodySchema = z.object({
  queueLabel: z.string().min(1),
  reason: z.unknown().optional(),
  messages: z
    .array(
      z.object({
        messageId: z.string().min(1),
        receiptHandle: z.string().min(1),
        body: z.string().min(1),
      })
    )
    .min(1)
    .max(100),
});

const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');

  const { queueLabel, messages } = parsed.data;
  const reason = parseAdminActionReason(parsed.data.reason);
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');
  const entry = getDlqByLabel(queueLabel);
  if (!entry) throw new BadRequestError(`Unknown DLQ: ${queueLabel}`);
  const dlqUrl = getDlqUrl(entry.label);

  const results: Array<{
    messageId: string;
    status: 'discarded' | 'failed';
    reason?: string;
    historyPending?: boolean;
  }> = [];
  for (const message of messages) {
    let logId: string;
    try {
      const log = await dlqReplayLogRepository.logReplay({
        queueLabel,
        messageId: message.messageId,
        messageBody: message.body,
        sourceQueue: entry.displayName,
        operation: 'discard',
        status: 'pending',
        reason,
        replayedBy: adminUserId,
      });
      logId = log.id;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error('[DLQ Discard] Failed to retain message before deletion', {
        messageId: message.messageId,
        queueLabel,
        error: errorMessage,
      });
      results.push({ messageId: message.messageId, status: 'failed', reason: errorMessage });
      continue;
    }

    let deleteError: string | undefined;
    try {
      await deleteFromQueue(dlqUrl, message.receiptHandle);
    } catch (error) {
      deleteError = error instanceof Error ? error.message : String(error);
      Logger.error('[DLQ Discard] Delete request failed', {
        messageId: message.messageId,
        queueLabel,
        error: deleteError,
      });
    }

    // An acknowledged deletion remains acknowledged even if the terminal history write fails.
    const status = deleteError === undefined ? 'discarded' : 'failed';
    let historyPending = false;
    try {
      await dlqReplayLogRepository.finalizeDiscard(logId, status, deleteError);
    } catch (error) {
      historyPending = true;
      Logger.error('[DLQ Discard] History finalization is unconfirmed', {
        messageId: message.messageId,
        queueLabel,
        observedStatus: status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    results.push({
      messageId: message.messageId,
      status,
      ...(deleteError !== undefined ? { reason: deleteError } : {}),
      ...(historyPending ? { historyPending: true } : {}),
    });
  }

  const discardedIds = results.filter(result => result.status === 'discarded').map(result => result.messageId);
  await recordAdminActionFromRequest(req, {
    action: 'ops.dlq.discarded',
    target: { kind: 'system', id: 'dlq-discard', displayName: 'DLQ discard' },
    summary: `discarded ${discardedIds.length} messages from ${queueLabel}`,
    reason,
    details: {
      queueLabel,
      messageCount: discardedIds.length,
      failed: results.length - discardedIds.length,
      discardedMessageIds: discardedIds,
      historyPendingMessageIds: results.filter(result => result.historyPending).map(result => result.messageId),
    },
  });
  return res.json({ discarded: discardedIds.length, failed: results.length - discardedIds.length, results });
});

export const config = { api: { externalResolver: true } };
export default handler;
