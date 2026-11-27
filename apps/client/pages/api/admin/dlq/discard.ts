import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqByLabel, getDlqUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { acquireDlqMessagesById } from '@bike4mind/server-utils/utils/dlqMessages';
import { adminAiSuggestionRepository, withTransaction } from '@bike4mind/database';
import { visibleDlqSuggestion } from '@bike4mind/server-utils/admin/dlq/triage';
import { triageActionSchema } from '@bike4mind/server-utils/admin/dlq/triagePolicy';
import { discardDlqMessages } from '@server/admin/dlq/discardMessages';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const MAX_BATCH_SIZE = 100;
// Upper bound on receives while searching the DLQ for the requested message IDs.
const TARGETED_MAX_RECEIVES = 20;
// Seconds the searched-for messages stay hidden while they are retained and deleted.
const TARGETED_VISIBILITY_SECONDS = 60;

const BodySchema = z
  .object({
    queueLabel: z.string().min(1),
    aiSuggestionId: z
      .string()
      .regex(/^[0-9a-f]{24}$/)
      .optional(),
    reason: z.unknown().optional(),
    messageIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE),
  })
  // Rejects a client-supplied `messages` payload: only bodies received from the DLQ itself are discarded.
  .strict();

const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');

  const { queueLabel, messageIds } = parsed.data;
  const reason = parseAdminActionReason(parsed.data.reason);
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');
  const entry = getDlqByLabel(queueLabel);
  if (!entry) throw new BadRequestError(`Unknown DLQ: ${queueLabel}`);
  const dlqUrl = getDlqUrl(entry.label);

  const aiSuggestionId = parsed.data.aiSuggestionId;
  if (aiSuggestionId) {
    if (messageIds.length !== 1) throw new BadRequestError('Suggestion approval requires one message ID');
    const suggestion = await visibleDlqSuggestion(queueLabel, messageIds[0]);
    const action = triageActionSchema.safeParse(suggestion?.proposedAction);
    if (
      !suggestion ||
      suggestion.id !== aiSuggestionId ||
      !action.success ||
      action.data.action !== 'discard' ||
      action.data.queueLabel !== queueLabel ||
      action.data.messageId !== messageIds[0]
    )
      throw new BadRequestError('Suggestion does not match this discard');
    await withTransaction(async () => {
      const decided = await adminAiSuggestionRepository.transition(aiSuggestionId, ['pending'], 'accepted', {
        decidedBy: { userId: adminUserId, name: req.user!.name || req.user!.username },
      });
      if (!decided) throw new BadRequestError('Suggestion has already been decided');
      await recordAdminActionFromRequest(req, {
        action: 'ops.dlq.triage.accepted',
        target: { kind: 'system', id: queueLabel, displayName: 'DLQ triage' },
        summary: 'approved a dead-letter discard recommendation',
        reason,
        details: { aiSuggestionId, queueLabel, messageId: messageIds[0] },
      });
    });
  }

  const acquired = await acquireDlqMessagesById(dlqUrl, queueLabel, messageIds, {
    maxReceives: TARGETED_MAX_RECEIVES,
    visibilityTimeout: TARGETED_VISIBILITY_SECONDS,
  });
  const messages = acquired.found.map(message => ({
    messageId: message.MessageId!,
    receiptHandle: message.ReceiptHandle!,
    body: message.Body ?? '',
  }));
  const notFound = acquired.notFound;
  if (notFound.length > 0) {
    Logger.warn(`[DLQ Discard] ${notFound.length} requested messageIds not found in DLQ`, {
      queueLabel,
      notFoundIds: notFound,
    });
  }

  const results = await discardDlqMessages({
    dlqUrl,
    queueLabel,
    sourceQueue: entry.displayName,
    reason,
    adminUserId,
    aiSuggestionId,
    messages,
    // A message acquired by ID is hidden; release it so it reappears for a retry right away.
    releaseUnretained: true,
  });

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
      notFoundMessageIds: notFound,
      ...(aiSuggestionId ? { aiSuggestionId } : {}),
    },
  });
  return res.json({
    discarded: discardedIds.length,
    failed: results.length - discardedIds.length,
    notFound: notFound.length,
    results,
  });
});

export const config = { api: { externalResolver: true } };
export default handler;
