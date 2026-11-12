import { ApiKeyScope } from '@bike4mind/common';
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
import { dlqReplayLogRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const MAX_REPLAY_ATTEMPTS = 3;
const MAX_BATCH_SIZE = 100;
// Upper bound on receives while searching the DLQ for specific message IDs.
const TARGETED_MAX_RECEIVES = 20;

const DirectMessageSchema = z.object({
  messageId: z.string().min(1),
  receiptHandle: z.string().min(1),
  body: z.string().min(1),
});

const BodySchema = z
  .object({
    queueLabel: z.string().min(1, 'queueLabel is required'),
    batchSize: z.number().int().min(1).max(MAX_BATCH_SIZE).optional().default(10),
    messageIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE).optional(),
    messages: z.array(DirectMessageSchema).min(1).max(MAX_BATCH_SIZE).optional(),
  })
  .refine(data => !(data.messageIds && data.messages), {
    message: 'Cannot specify both messageIds and messages',
  });

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
 * Replays messages from a DLQ back to its source queue.
 *
 * Two modes:
 * - Direct: Client passes `messages` with receipt handles from a prior peek.
 *   Sends to source queue and deletes using the provided handles.
 * - Batch: Receives messages from the DLQ (optionally filtered by `messageIds`),
 *   sends to source queue, then deletes from DLQ on success.
 */
const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const result = BodySchema.safeParse(req.body);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
  }

  const { queueLabel, batchSize, messageIds, messages: directMessages } = result.data;
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  const dlqEntry = getDlqByLabel(queueLabel);
  if (!dlqEntry) {
    throw new BadRequestError(`Unknown DLQ: ${queueLabel}`);
  }

  if (!dlqEntry.sourceQueue) {
    throw new BadRequestError(`Replay is not available for DLQ: ${queueLabel}`);
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
      details: {
        queueLabel,
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
      await dlqReplayLogRepository.logReplay(data);
    } catch (logError) {
      Logger.error(`[DLQ Replay] Failed to write audit log for message ${data.messageId}`, {
        error: logError instanceof Error ? logError.message : String(logError),
        queueLabel: data.queueLabel,
      });
    }
  };

  // --- Direct replay path: uses receipt handles from peek to avoid re-receive ---
  if (directMessages && directMessages.length > 0) {
    Logger.info(`[DLQ Replay] Direct replay of ${directMessages.length} messages from ${queueLabel}`, {
      adminUserId,
      messageIds: directMessages.map(m => m.messageId),
    });

    for (const dm of directMessages) {
      try {
        const attemptCount = await dlqReplayLogRepository.countAttempts(dm.messageId);
        if (attemptCount >= MAX_REPLAY_ATTEMPTS) {
          results.push({
            messageId: dm.messageId,
            status: 'skipped',
            reason: `Max replay attempts (${MAX_REPLAY_ATTEMPTS}) exceeded`,
          });
          await safeLogReplay({
            queueLabel,
            messageId: dm.messageId,
            messageBody: dm.body,
            sourceQueue: dlqEntry.displayName,
            status: 'skipped',
            errorMessage: `Max replay attempts (${MAX_REPLAY_ATTEMPTS}) exceeded`,
            replayedBy: adminUserId,
          });
          continue;
        }

        let parsedBody: Record<string, unknown>;
        try {
          parsedBody = JSON.parse(dm.body);
        } catch (parseErr) {
          throw new Error(
            `Message body is not valid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
          );
        }
        await sendToQueue(sourceQueueUrl, parsedBody);

        // Delete from DLQ using the receipt handle from peek
        try {
          await deleteFromQueue(dlqUrl, dm.receiptHandle);
        } catch (deleteError) {
          // Receipt handle may have expired - fallback: re-receive and find by messageId
          Logger.warn(`[DLQ Replay] Receipt handle expired for ${dm.messageId}, attempting fallback receive`, {
            error: deleteError instanceof Error ? deleteError.message : String(deleteError),
            queueLabel,
          });

          let fallbackDeleted = false;
          const fallbackMessages = await receiveFromQueue(dlqUrl, 10, 60);
          const match = fallbackMessages.find(m => m.MessageId === dm.messageId);
          if (match?.ReceiptHandle) {
            try {
              await deleteFromQueue(dlqUrl, match.ReceiptHandle);
              fallbackDeleted = true;
            } catch (fallbackDeleteError) {
              Logger.error(`[DLQ Replay] Fallback delete also failed for ${dm.messageId}`, {
                error: fallbackDeleteError instanceof Error ? fallbackDeleteError.message : String(fallbackDeleteError),
              });
            }
          }

          if (!fallbackDeleted) {
            Logger.error(
              `[DLQ Replay] Message ${dm.messageId} sent to source but delete from DLQ failed — DUPLICATE RISK`,
              { queueLabel }
            );
            results.push({
              messageId: dm.messageId,
              status: 'replayed',
              reason: 'Warning: delete from DLQ failed — message may be duplicated',
            });
            await safeLogReplay({
              queueLabel,
              messageId: dm.messageId,
              messageBody: dm.body,
              sourceQueue: dlqEntry.displayName,
              status: 'success',
              errorMessage: 'Delete from DLQ failed after fallback',
              replayedBy: adminUserId,
            });
            continue;
          }
        }

        results.push({ messageId: dm.messageId, status: 'replayed' });
        await safeLogReplay({
          queueLabel,
          messageId: dm.messageId,
          messageBody: dm.body,
          sourceQueue: dlqEntry.displayName,
          status: 'success',
          replayedBy: adminUserId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({ messageId: dm.messageId, status: 'failed', reason: errorMessage });
        Logger.error(`[DLQ Replay] Failed to replay message ${dm.messageId}`, { error: errorMessage, queueLabel });
        await safeLogReplay({
          queueLabel,
          messageId: dm.messageId,
          messageBody: dm.body,
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
      notFound: 0,
      total: results.length,
      results,
    };

    Logger.info(`[DLQ Replay] Completed direct replay for ${queueLabel}`, { adminUserId, ...summary });
    await recordReplayAudit(summary);
    return res.json(summary);
  }

  // --- Batch replay path: receive from SQS and replay ---

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
    const iterations = Math.ceil(batchSize / 10);
    for (let i = 0; i < iterations; i++) {
      const toReceive = Math.min(batchSize - allMessages.length, 10);
      const messages = await receiveFromQueue(dlqUrl, toReceive, 60);
      allMessages.push(...messages);

      // Stop if no more messages
      if (messages.length < toReceive) break;
    }
    messagesToReplay = allMessages;
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
