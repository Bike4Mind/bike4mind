import type { Message } from '@aws-sdk/client-sqs';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqByLabel, getDlqUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { changeMessageVisibility, receiveFromQueue } from '@bike4mind/server-utils/utils/sqs';
import { DLQ_BROWSE_MESSAGE_ATTRIBUTES, findDlqFailures } from '@bike4mind/server-utils/utils/dlqMessages';
import { dlqFailureSignature, rowFailure } from '@bike4mind/server-utils/utils/dlqMessageRow';
import { discardDlqMessages, type DlqDiscardOutcome } from '@server/admin/dlq/discardMessages';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

// One call is bounded so it finishes well inside the API timeout; the client calls again until `complete`.
const GROUP_DISCARD_MAX_PER_CALL = 50;
const MAX_RECEIVES = 15;
const TIME_BUDGET_MS = 12_000;
// Examined messages stay hidden while the call runs, so a receive keeps surfacing new ones; the rest are
// released when it ends. A crash leaves them hidden for at most this long.
const HOLD_SECONDS = 60;
// Short-poll sampling can come back empty on a sparse queue, so one empty receive is not the end.
const EMPTY_RECEIVES_BEFORE_STOP = 2;

const BodySchema = z.object({
  queueLabel: z.string().min(1),
  failureSignature: z.string().regex(/^([0-9a-f]{16}|none)$/, 'failureSignature must come from a dead-letter listing'),
  reason: z.unknown().optional(),
  limit: z.number().int().min(1).max(GROUP_DISCARD_MAX_PER_CALL).optional(),
});

export type DlqGroupDiscardStop = 'exhausted' | 'limit' | 'budget' | 'lookup_failed';

/**
 * POST /api/admin/dlq/discard-group
 *
 * Discards up to `limit` messages of one queue whose failure signature (see dlqFailureSignature) matches the
 * group shown in the listing. Messages are received and matched here, so the caller never names them; each
 * is discarded through discardDlqMessages (history row before the delete), and non-matching messages are
 * released untouched. `complete` is true once the queue has no visible messages left to examine.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
  const { queueLabel, failureSignature } = parsed.data;
  const limit = parsed.data.limit ?? GROUP_DISCARD_MAX_PER_CALL;
  const reason = parseAdminActionReason(parsed.data.reason);
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');
  const entry = getDlqByLabel(queueLabel);
  if (!entry) throw new BadRequestError(`Unknown DLQ: ${queueLabel}`);
  const dlqUrl = getDlqUrl(entry.label);

  const startedAt = Date.now();
  const held: Message[] = [];
  const seen = new Set<string>();
  const results: DlqDiscardOutcome[] = [];
  let examined = 0;
  let emptyReceives = 0;
  let stoppedBy: DlqGroupDiscardStop = 'budget';
  let thrown: unknown;
  try {
    for (let receives = 0; receives < MAX_RECEIVES && Date.now() - startedAt < TIME_BUDGET_MS; receives++) {
      if (results.length >= limit) {
        stoppedBy = 'limit';
        break;
      }
      const batch = await receiveFromQueue(dlqUrl, 10, HOLD_SECONDS, 1, DLQ_BROWSE_MESSAGE_ATTRIBUTES);
      const fresh = batch.filter(message => message.MessageId && !seen.has(message.MessageId));
      held.push(...batch.filter(message => !fresh.includes(message)));
      if (fresh.length === 0) {
        emptyReceives++;
        if (emptyReceives >= EMPTY_RECEIVES_BEFORE_STOP) {
          stoppedBy = 'exhausted';
          break;
        }
        continue;
      }
      emptyReceives = 0;
      for (const message of fresh) seen.add(message.MessageId!);
      examined += fresh.length;

      const { failures, lookupFailed } = await findDlqFailures(
        queueLabel,
        entry.sourceQueue,
        fresh.map(message => message.MessageId!)
      );
      if (lookupFailed) {
        // Without recorded failures a message could match the wrong group, so nothing more is discarded.
        held.push(...fresh);
        stoppedBy = 'lookup_failed';
        break;
      }
      const recordedById = new Map(failures.map(failure => [failure.messageId, failure]));
      const matching: Message[] = [];
      for (const message of fresh) {
        const signature = dlqFailureSignature(rowFailure(message, recordedById.get(message.MessageId!)));
        if (signature === failureSignature && results.length + matching.length < limit) matching.push(message);
        else held.push(message);
      }
      results.push(
        ...(await discardDlqMessages({
          dlqUrl,
          queueLabel,
          sourceQueue: entry.displayName,
          reason,
          adminUserId,
          messages: matching.map(message => ({
            messageId: message.MessageId!,
            receiptHandle: message.ReceiptHandle!,
            body: message.Body ?? '',
          })),
          releaseUnretained: true,
        }))
      );
    }
  } catch (error) {
    thrown = error;
  } finally {
    await releaseHeld(dlqUrl, queueLabel, held);
  }
  // Earlier rounds may already have deleted messages, so a failed call still records what it discarded.
  if (thrown !== undefined && results.length === 0) throw thrown;
  if (stoppedBy === 'budget' && results.length >= limit) stoppedBy = 'limit';

  const discardedIds = results.filter(result => result.status === 'discarded').map(result => result.messageId);
  await recordAdminActionFromRequest(req, {
    action: 'ops.dlq.discarded',
    target: { kind: 'system', id: 'dlq-discard', displayName: 'DLQ discard' },
    summary: `discarded ${discardedIds.length} messages from ${queueLabel} by failure group`,
    reason,
    details: {
      queueLabel,
      failureSignature,
      messageCount: discardedIds.length,
      failed: results.length - discardedIds.length,
      examined,
      stoppedBy: thrown === undefined ? stoppedBy : 'error',
      ...(thrown !== undefined ? { error: thrown instanceof Error ? thrown.message : String(thrown) } : {}),
      discardedMessageIds: discardedIds,
      historyPendingMessageIds: results.filter(result => result.historyPending).map(result => result.messageId),
    },
  });
  if (thrown !== undefined) throw thrown;
  return res.json({
    discarded: discardedIds.length,
    failed: results.length - discardedIds.length,
    examined,
    stoppedBy,
    complete: stoppedBy === 'exhausted',
    results,
  });
});

async function releaseHeld(dlqUrl: string, queueLabel: string, messages: readonly Message[]): Promise<void> {
  const settled = await Promise.allSettled(
    messages.filter(message => message.ReceiptHandle).map(m => changeMessageVisibility(dlqUrl, m.ReceiptHandle!, 0))
  );
  const failed = settled.filter(result => result.status === 'rejected').length;
  if (failed > 0) {
    Logger.warn(`[DLQ Group Discard] ${failed} messages stay hidden until their visibility expires`, {
      queueLabel,
      holdSeconds: HOLD_SECONDS,
    });
  }
}

export const config = { api: { externalResolver: true } };
export default handler;
