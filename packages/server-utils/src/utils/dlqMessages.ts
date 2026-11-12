import type { Message } from '@aws-sdk/client-sqs';
import { recommendDlqAction, type DlqRecommendation } from '@bike4mind/common';
import { dlqFailureRepository, dlqReplayLogRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { buildLogsInsightsUrl, messageLogWindow, type ConsumerLogs } from './dlqConsumerLogs';
import { getSourceQueueUrl, type SourceQueueName } from './dlqRegistry';
import { changeMessageVisibility, receiveFromQueue } from './sqs';

const SQS_MAX_BATCH = 10;
// Two receives in a row that surface nothing new mean the visible messages are exhausted.
const STALE_RECEIVES_BEFORE_STOP = 2;

export const approximateReceiveCount = (message: Message): number =>
  parseInt(message.Attributes?.ApproximateReceiveCount ?? '0', 10) || 0;

/** A visibility-0 receive can return the same message more than once; keep the latest copy of each. */
export function latestCopies(messages: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    if (!message.MessageId) continue;
    const existing = byId.get(message.MessageId);
    if (!existing || approximateReceiveCount(message) > approximateReceiveCount(existing)) {
      byId.set(message.MessageId, message);
    }
  }
  return [...byId.values()];
}

/**
 * Browse up to `limit` distinct messages from a DLQ without hiding them (visibility 0), so other
 * admins and replays still see them. SQS has no listing API: each short-poll receive samples an
 * arbitrary subset, so this repeats receives until it has `limit` messages, the queue stops
 * yielding new ones, or `maxReceives` runs out. SQS increments ApproximateReceiveCount per receive.
 */
export async function browseDlqMessages(
  dlqUrl: string,
  options: { limit: number; maxReceives: number }
): Promise<Message[]> {
  let collected: Message[] = [];
  let staleReceives = 0;
  for (let i = 0; i < options.maxReceives && collected.length < options.limit; i++) {
    const batch = await receiveFromQueue(dlqUrl, SQS_MAX_BATCH, 0);
    if (batch.length === 0) break;
    const before = collected.length;
    collected = latestCopies([...collected, ...batch]);
    staleReceives = collected.length === before ? staleReceives + 1 : 0;
    if (staleReceives >= STALE_RECEIVES_BEFORE_STOP) break;
  }
  return collected.slice(0, options.limit);
}

async function releaseMessages(dlqUrl: string, queueLabel: string, messages: readonly Message[]): Promise<void> {
  const released = await Promise.allSettled(
    messages.filter(m => m.ReceiptHandle).map(m => changeMessageVisibility(dlqUrl, m.ReceiptHandle!, 0))
  );
  const errors = released.flatMap(r =>
    r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []
  );
  if (errors.length > 0) {
    Logger.warn(`[DLQ] Could not release ${errors.length} messages early`, {
      queueLabel,
      // Distinct messages only: a missing permission fails every release the same way.
      errors: [...new Set(errors)],
    });
  }
}

/**
 * Receive the given messages from a DLQ by ID, hiding them for `visibilityTimeout` seconds so the
 * caller holds a fresh receipt handle. SQS cannot fetch by ID, so this receives repeatedly; anything
 * else it picks up is released straight away. Best effort: IDs it cannot reach come back in `notFound`.
 */
export async function acquireDlqMessagesById(
  dlqUrl: string,
  queueLabel: string,
  messageIds: readonly string[],
  options: { maxReceives: number; visibilityTimeout: number }
): Promise<{ found: Message[]; notFound: string[] }> {
  const wanted = new Set(messageIds);
  const found = new Map<string, Message>();
  const others: Message[] = [];
  try {
    for (let i = 0; i < options.maxReceives && found.size < wanted.size; i++) {
      // Long polling (1s) reduces the empty responses short-poll sampling gives on sparse queues.
      const batch = await receiveFromQueue(dlqUrl, SQS_MAX_BATCH, options.visibilityTimeout, 1);
      if (batch.length === 0) break;
      for (const message of batch) {
        if (message.MessageId && wanted.has(message.MessageId)) found.set(message.MessageId, message);
        else others.push(message);
      }
    }
  } catch (error) {
    await releaseMessages(dlqUrl, queueLabel, [...others, ...found.values()]);
    throw error;
  }
  await releaseMessages(dlqUrl, queueLabel, others);
  return { found: [...found.values()], notFound: messageIds.filter(id => !found.has(id)) };
}

export function messageLogsUrl(logs: ConsumerLogs | null, sentTimestamp: string | undefined): string | null {
  if (!logs || !sentTimestamp) return null;
  const window = messageLogWindow(parseInt(sentTimestamp, 10), logs.retryWindowMs);
  return window ? buildLogsInsightsUrl({ region: logs.region, logGroups: logs.logGroups, ...window }) : null;
}

/** Recorded failure details for DLQ messages; `lookupFailed` lets the UI say details are unavailable. */
export async function findDlqFailures(
  queueLabel: string,
  sourceQueue: SourceQueueName | null,
  messageIds: string[]
): Promise<{ failures: Awaited<ReturnType<typeof dlqFailureRepository.findForMessages>>; lookupFailed: boolean }> {
  if (!sourceQueue || !messageIds.length) return { failures: [], lookupFailed: false };
  try {
    const sourceQueueName = new URL(getSourceQueueUrl(sourceQueue)).pathname.split('/').pop();
    if (!sourceQueueName) return { failures: [], lookupFailed: false };
    const failures = await dlqFailureRepository.findForMessages(sourceQueueName, messageIds);
    return { failures, lookupFailed: false };
  } catch (error) {
    Logger.warn('[DLQ Messages] Failure details unavailable', {
      queueLabel,
      errorName: error instanceof Error ? error.name : 'Unknown',
    });
    return { failures: [], lookupFailed: true };
  }
}

type DlqFailureRecord = Awaited<ReturnType<typeof dlqFailureRepository.findForMessages>>[number];

/** Recorded replay attempts per message ID in one query; null when the lookup fails. */
export async function countDlqReplayAttempts(
  queueLabel: string,
  messageIds: readonly string[]
): Promise<Map<string, number> | null> {
  try {
    return await dlqReplayLogRepository.countAttemptsByMessage(messageIds);
  } catch (error) {
    Logger.warn('[DLQ Messages] Replay attempts unavailable', {
      queueLabel,
      errorName: error instanceof Error ? error.name : 'Unknown',
    });
    return null;
  }
}

/** The advisory next step for one DLQ message, from the facts recorded about it. */
export function recommendForDlqMessage(facts: {
  failure: DlqFailureRecord | undefined;
  logs: ConsumerLogs | null;
  replayAttempts: number | undefined;
  replaySafety: string | undefined;
}): DlqRecommendation {
  return recommendDlqAction({
    category: facts.failure?.category,
    errorType: facts.failure?.errorType,
    failedAt: facts.failure?.failedAt?.toISOString(),
    consumerDeployedAt: facts.logs?.consumerDeployedAt,
    replayAttempts: facts.replayAttempts,
    replaySafety: facts.replaySafety,
  });
}
