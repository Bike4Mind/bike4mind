import type { Message } from '@aws-sdk/client-sqs';
import { Logger } from '@bike4mind/observability';
import { changeMessageVisibility, receiveFromQueue } from '@bike4mind/server-utils/utils/sqs';

// Upper bound on receives while searching the DLQ for specific message IDs.
const TARGETED_MAX_RECEIVES = 20;
// Seconds a targeted receive keeps the found messages hidden, so their receipt handles stay valid for the caller.
const TARGETED_VISIBILITY_SECONDS = 60;

/** Makes received messages visible again straight away instead of after their visibility timeout. */
export async function releaseReceivedMessages(
  dlqUrl: string,
  queueLabel: string,
  messages: readonly Message[],
  kind: 'untargeted' | 'acquired',
  logPrefix: string
): Promise<void> {
  const released = await Promise.allSettled(
    messages.filter(m => m.ReceiptHandle).map(m => changeMessageVisibility(dlqUrl, m.ReceiptHandle!, 0))
  );
  const releaseErrors = released.flatMap(r =>
    r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []
  );
  if (releaseErrors.length > 0) {
    Logger.warn(`${logPrefix} Could not release ${releaseErrors.length} ${kind} messages early`, {
      queueLabel,
      // Distinct messages only: a missing permission fails every release the same way.
      errors: [...new Set(releaseErrors)],
    });
  }
}

/**
 * Receives the given message IDs from a DLQ with a fresh receipt handle each, releasing every other
 * message the search picked up. IDs the search does not reach are absent from `found`; `receivedCount`
 * counts every message received along the way.
 * Shared by the replay and discard routes (`pages/api/admin/dlq/replay.ts`, `discard.ts`).
 */
export async function receiveDlqMessagesByIds(
  dlqUrl: string,
  queueLabel: string,
  messageIds: ReadonlySet<string>,
  logPrefix: string
): Promise<{ found: Message[]; receivedCount: number }> {
  // SQS cannot fetch a message by ID and a receive returns an arbitrary subset, often a
  // single message on a small queue. Each receive hides what it returned, so the next one
  // surfaces different messages; keep going until every target is found. Long polling reduces
  // empty responses caused by short-poll sampling.
  const received: Message[] = [];
  const found = new Map<string, Message>();
  const others: Message[] = [];
  try {
    for (let i = 0; i < TARGETED_MAX_RECEIVES && found.size < messageIds.size; i++) {
      const messages = await receiveFromQueue(dlqUrl, 10, TARGETED_VISIBILITY_SECONDS, 1);
      if (messages.length === 0) break;
      received.push(...messages);
      for (const m of messages) {
        const id = m.MessageId ?? '';
        if (!messageIds.has(id)) others.push(m);
        else found.set(id, m);
      }
    }
  } catch (error) {
    await releaseReceivedMessages(dlqUrl, queueLabel, received, 'acquired', logPrefix);
    throw error;
  }

  // Hand back the messages the search picked up but was not asked for,
  // so they do not stay hidden for the rest of the visibility timeout.
  await releaseReceivedMessages(dlqUrl, queueLabel, others, 'untargeted', logPrefix);
  return { found: [...found.values()], receivedCount: received.length };
}
