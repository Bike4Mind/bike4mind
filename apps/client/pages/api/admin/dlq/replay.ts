import {
  ApiKeyScope,
  AdminActionReasonSchema,
  DLQ_MAX_REPLAY_ATTEMPTS,
  requiresDlqReplayReason,
} from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqByLabel, getDlqUrl, getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import {
  receiveFromQueue,
  sendToQueue,
  deleteFromQueue,
  changeMessageVisibility,
} from '@bike4mind/server-utils/utils/sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { dlqReplayLogRepository, adminAiSuggestionRepository, withTransaction } from '@bike4mind/database';
import { visibleDlqSuggestion } from '@bike4mind/server-utils/admin/dlq/triage';
import { triageActionSchema } from '@bike4mind/server-utils/admin/dlq/triagePolicy';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const MAX_REPLAY_ATTEMPTS = DLQ_MAX_REPLAY_ATTEMPTS;
const MAX_BATCH_SIZE = 100;
// Short polling samples a subset of SQS servers, so a receive can miss messages the queue holds.
const RECEIVE_WAIT_SECONDS = 2;
// Upper bound on receives while searching the DLQ for specific message IDs.
const TARGETED_MAX_RECEIVES = 20;

const BodySchema = z
  .object({
    queueLabel: z.string().min(1, 'queueLabel is required'),
    aiSuggestionId: z
      .string()
      .regex(/^[0-9a-f]{24}$/)
      .optional(),
    batchSize: z.number().int().min(1).max(MAX_BATCH_SIZE).optional().default(10),
    messageIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE).optional(),
    reason: AdminActionReasonSchema.optional(),
  })
  // Rejects a client-supplied `messages` payload: only bodies received from the DLQ itself are replayed.
  .strict();

// API uses 'replayed' for user-facing clarity; maps to 'success' in DlqReplayLog DB model
interface ReplayResult {
  messageId: string;
  status: 'replayed' | 'failed' | 'skipped';
  reason?: string;
}

async function releaseReceivedMessages(
  dlqUrl: string,
  queueLabel: string,
  messages: readonly Message[],
  kind: 'untargeted' | 'acquired'
): Promise<void> {
  const released = await Promise.allSettled(
    messages.filter(m => m.ReceiptHandle).map(m => changeMessageVisibility(dlqUrl, m.ReceiptHandle!, 0))
  );
  const releaseErrors = released.flatMap(r =>
    r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []
  );
  if (releaseErrors.length > 0) {
    Logger.warn(`[DLQ Replay] Could not release ${releaseErrors.length} ${kind} messages early`, {
      queueLabel,
      // Distinct messages only: a missing permission fails every release the same way.
      errors: [...new Set(releaseErrors)],
    });
  }
}

/**
 * POST /api/admin/dlq/replay
 *
 * Receives messages from a DLQ (optionally filtered by `messageIds`), sends each stored body
 * back to its source queue, then deletes it from the DLQ on success.
 */
const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const result = BodySchema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue?.code === 'unrecognized_keys') {
      throw new BadRequestError(
        `Unsupported field(s): ${issue.keys.join(', ')}. Accepted fields: ${Object.keys(BodySchema.shape).join(', ')}`
      );
    }
    throw new BadRequestError(issue?.message || 'Invalid request body');
  }

  const { queueLabel, batchSize, messageIds, reason } = result.data;
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  const dlqEntry = getDlqByLabel(queueLabel);
  if (!dlqEntry) {
    throw new BadRequestError(`Unknown DLQ: ${queueLabel}`);
  }

  if (!dlqEntry.sourceQueue) {
    throw new BadRequestError(`Replay is not available for DLQ: ${queueLabel}`);
  }

  if ((requiresDlqReplayReason(dlqEntry.replay) || result.data.aiSuggestionId) && !reason) {
    throw new BadRequestError('A reason of at least 5 characters is required for this replay');
  }

  const aiSuggestionId = result.data.aiSuggestionId;
  if (aiSuggestionId) {
    if (messageIds?.length !== 1) throw new BadRequestError('Suggestion approval requires one message ID');
    const suggestion = await visibleDlqSuggestion(queueLabel, messageIds[0]);
    const action = triageActionSchema.safeParse(suggestion?.proposedAction);
    if (
      !suggestion ||
      suggestion.id !== aiSuggestionId ||
      !action.success ||
      action.data.action !== 'replay' ||
      action.data.queueLabel !== queueLabel ||
      action.data.messageId !== messageIds[0]
    )
      throw new BadRequestError('Suggestion does not match this replay');
    await withTransaction(async () => {
      const decided = await adminAiSuggestionRepository.transition(aiSuggestionId, ['pending'], 'accepted', {
        decidedBy: { userId: adminUserId, name: req.user!.name || req.user!.username },
      });
      if (!decided) throw new BadRequestError('Suggestion has already been decided');
      await recordAdminActionFromRequest(req, {
        action: 'ops.dlq.triage.accepted',
        target: { kind: 'system', id: queueLabel, displayName: 'DLQ triage' },
        summary: 'approved a dead-letter replay recommendation',
        reason,
        details: { aiSuggestionId, queueLabel, messageId: messageIds[0] },
      });
    });
  }

  const dlqUrl = getDlqUrl(dlqEntry.label);
  const sourceQueueUrl = getSourceQueueUrl(dlqEntry.sourceQueue);
  const results: ReplayResult[] = [];

  const recordReplayAudit = (summary: {
    replayed: number;
    failed: number;
    skipped: number;
    total: number;
    results: ReplayResult[];
  }) =>
    recordAdminActionFromRequest(req, {
      action: 'ops.dlq.replayed',
      target: { kind: 'system', id: 'dlq-replay', displayName: 'DLQ replay' },
      summary: `replayed ${summary.replayed} messages from ${queueLabel}`,
      reason,
      details: {
        queueLabel,
        ...(aiSuggestionId ? { aiSuggestionId } : {}),
        messageCount: summary.replayed,
        failed: summary.failed,
        skipped: summary.skipped,
        total: summary.total,
        // IDs only, never bodies; bounded by MAX_BATCH_SIZE via the request schema.
        replayedMessageIds: summary.results.filter(r => r.status === 'replayed').map(r => r.messageId),
      },
    });

  const safeLogReplay = async (data: Omit<Parameters<typeof dlqReplayLogRepository.logReplay>[0], never>) => {
    try {
      await dlqReplayLogRepository.logReplay({
        ...data,
        ...(aiSuggestionId ? { aiSuggestionId, operation: 'replay' as const } : {}),
      });
    } catch (logError) {
      Logger.error(`[DLQ Replay] Failed to write audit log for message ${data.messageId}`, {
        error: logError instanceof Error ? logError.message : String(logError),
        queueLabel: data.queueLabel,
      });
    }
  };

  const allMessages: Message[] = [];
  const messageIdSet = messageIds ? new Set(messageIds) : null;
  let messagesToReplay: Message[];

  if (messageIdSet) {
    // SQS cannot fetch a message by ID and a receive returns an arbitrary subset, often a
    // single message on a small queue. Each receive hides what it returned, so the next one
    // surfaces different messages; keep going until every target is found. Long polling reduces
    // empty responses caused by short-poll sampling.
    const found = new Map<string, Message>();
    const others: Message[] = [];
    try {
      for (let i = 0; i < TARGETED_MAX_RECEIVES && found.size < messageIdSet.size; i++) {
        const messages = await receiveFromQueue(dlqUrl, 10, 60, 1);
        if (messages.length === 0) break;
        allMessages.push(...messages);
        for (const m of messages) {
          const id = m.MessageId ?? '';
          if (!messageIdSet.has(id)) others.push(m);
          else found.set(id, m);
        }
      }
    } catch (error) {
      await releaseReceivedMessages(dlqUrl, queueLabel, allMessages, 'acquired');
      throw error;
    }
    messagesToReplay = [...found.values()];

    // Hand back the messages the search picked up but was not asked to replay,
    // so they do not stay hidden for the rest of the visibility timeout.
    await releaseReceivedMessages(dlqUrl, queueLabel, others, 'untargeted');
  } else {
    // Each non-empty receive adds at least one message, so batchSize calls is a hard upper bound.
    for (let i = 0; i < batchSize && allMessages.length < batchSize; i++) {
      const toReceive = Math.min(batchSize - allMessages.length, 10);
      const messages = await receiveFromQueue(dlqUrl, toReceive, 60, RECEIVE_WAIT_SECONDS);
      allMessages.push(...messages);

      // SQS can return fewer messages than it holds, so only an empty receive means the queue is drained.
      if (messages.length === 0) break;
    }
    // At-least-once delivery can return one message twice in a run; keep the latest copy, whose receipt handle is the valid one.
    messagesToReplay = [...new Map(allMessages.map(m => [m.MessageId ?? '', m])).values()];
  }

  // Track which requested messageIds were not found in the received batch
  const notFoundCount = messageIds ? messageIds.length - messagesToReplay.length : 0;
  if (messageIds && notFoundCount > 0) {
    const foundIds = new Set(messagesToReplay.map(m => m.MessageId));
    const notFoundIds = messageIds.filter(id => !foundIds.has(id));
    Logger.warn(`[DLQ Replay] ${notFoundCount} requested messageIds not found in DLQ`, {
      adminUserId,
      queueLabel,
      notFoundIds,
      totalReceived: allMessages.length,
    });
  }

  Logger.info(`[DLQ Replay] Starting replay of ${messagesToReplay.length} messages from ${queueLabel}`, {
    adminUserId,
    batchSize,
    messageIds: messageIds ?? 'all',
    messagesReceived: allMessages.length,
    messagesToReplay: messagesToReplay.length,
  });

  for (const msg of messagesToReplay) {
    const messageId = msg.MessageId ?? 'unknown';
    const messageBody = msg.Body ?? '';

    try {
      // Check replay attempt count
      const attemptCount = await dlqReplayLogRepository.countAttempts(messageId);
      if (attemptCount >= MAX_REPLAY_ATTEMPTS) {
        results.push({ messageId, status: 'skipped', reason: `Max replay attempts (${MAX_REPLAY_ATTEMPTS}) exceeded` });
        await safeLogReplay({
          queueLabel,
          messageId,
          messageBody,
          sourceQueue: dlqEntry.displayName,
          status: 'skipped',
          errorMessage: `Max replay attempts (${MAX_REPLAY_ATTEMPTS}) exceeded`,
          replayedBy: adminUserId,
        });
        continue;
      }

      // Parse message body and send to source queue
      if (!msg.Body) {
        throw new Error('Message has empty body; cannot replay');
      }
      const parsedBody = JSON.parse(msg.Body);
      await sendToQueue(sourceQueueUrl, parsedBody);

      // Delete from DLQ after successful send
      try {
        if (!msg.ReceiptHandle) {
          throw new Error('Message is missing ReceiptHandle; cannot delete from DLQ after replay');
        }
        await deleteFromQueue(dlqUrl, msg.ReceiptHandle);
      } catch (deleteError) {
        const deleteMsg = deleteError instanceof Error ? deleteError.message : String(deleteError);
        Logger.error(`[DLQ Replay] Message ${messageId} sent to source but delete from DLQ failed — DUPLICATE RISK`, {
          error: deleteMsg,
          queueLabel,
        });
        results.push({ messageId, status: 'replayed', reason: `Warning: delete from DLQ failed — ${deleteMsg}` });
        await safeLogReplay({
          queueLabel,
          messageId,
          messageBody,
          sourceQueue: dlqEntry.displayName,
          status: 'success',
          errorMessage: `Delete from DLQ failed: ${deleteMsg}`,
          replayedBy: adminUserId,
        });
        continue;
      }

      results.push({ messageId, status: 'replayed' });
      await safeLogReplay({
        queueLabel,
        messageId,
        messageBody,
        sourceQueue: dlqEntry.displayName,
        status: 'success',
        replayedBy: adminUserId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({ messageId, status: 'failed', reason: errorMessage });
      Logger.error(`[DLQ Replay] Failed to replay message ${messageId}`, { error: errorMessage, queueLabel });
      await safeLogReplay({
        queueLabel,
        messageId,
        messageBody,
        sourceQueue: dlqEntry.displayName,
        status: 'failed',
        errorMessage,
        replayedBy: adminUserId,
      });
    }
  }

  const summary = {
    replayed: results.filter(r => r.status === 'replayed').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    notFound: notFoundCount,
    total: results.length,
    results,
  };

  Logger.info(`[DLQ Replay] Completed replay for ${queueLabel}`, {
    adminUserId,
    ...summary,
  });

  await recordReplayAudit(summary);
  return res.json(summary);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
