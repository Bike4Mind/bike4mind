import { dlqReplayLogRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { changeMessageVisibility, deleteFromQueue } from '@bike4mind/server-utils/utils/sqs';

export type DlqDiscardTarget = { messageId: string; receiptHandle: string; body: string };

export type DlqDiscardOutcome = {
  messageId: string;
  status: 'discarded' | 'failed';
  reason?: string;
  historyPending?: boolean;
};

/**
 * Discards messages one at a time: a pending history row first (the body is kept for recovery), then the SQS
 * delete, then the row's terminal status. A message whose history row cannot be written is never deleted;
 * with `releaseUnretained` it is made visible again so a retry sees it at once. Shared by the discard and
 * discard-group routes so both keep the same per-message audit.
 */
export async function discardDlqMessages(params: {
  dlqUrl: string;
  queueLabel: string;
  sourceQueue: string;
  reason: string;
  adminUserId: string;
  aiSuggestionId?: string;
  messages: readonly DlqDiscardTarget[];
  releaseUnretained: boolean;
}): Promise<DlqDiscardOutcome[]> {
  const { dlqUrl, queueLabel } = params;
  const results: DlqDiscardOutcome[] = [];
  for (const message of params.messages) {
    let logId: string;
    try {
      const log = await dlqReplayLogRepository.logReplay({
        queueLabel,
        messageId: message.messageId,
        messageBody: message.body,
        sourceQueue: params.sourceQueue,
        operation: 'discard',
        ...(params.aiSuggestionId ? { aiSuggestionId: params.aiSuggestionId } : {}),
        status: 'pending',
        reason: params.reason,
        replayedBy: params.adminUserId,
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
      if (params.releaseUnretained) {
        await changeMessageVisibility(dlqUrl, message.receiptHandle, 0).catch(releaseError =>
          Logger.warn('[DLQ Discard] Could not release message; it reappears when its visibility expires', {
            messageId: message.messageId,
            queueLabel,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          })
        );
      }
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
  return results;
}
