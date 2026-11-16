import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import {
  describeDlqMessage,
  getDlqRegistry,
  getDlqUrl,
  type RegisteredDlqDescriptor,
} from '@bike4mind/server-utils/utils/dlqRegistry';
import {
  CONSUMER_LOGS_BUDGET_MS,
  resolveConsumerLogsForSourceQueue,
  settleWithinBudget,
  type ConsumerLogs,
} from '@bike4mind/server-utils/utils/dlqConsumerLogs';
import {
  browseDlqMessages,
  countDlqReplayAttempts,
  findDlqFailures,
  messageLogsUrl,
  recommendForDlqMessage,
} from '@bike4mind/server-utils/utils/dlqMessages';
import { getQueueAttributes } from '@bike4mind/server-utils/utils/sqs';
import { Logger } from '@bike4mind/observability';

// Bounds one listing: at most 50 messages from each queue, 8 receives each, 6 queues browsed at once.
const PER_QUEUE_LIMIT = 50;
const MAX_RECEIVES_PER_QUEUE = 8;
const QUEUE_CONCURRENCY = 6;

type QueueListing = {
  label: string;
  /** -1 when the queue attributes could not be read, or the queue is not created on this stage. */
  approximateMessageCount: number;
  listed: number;
  failed: boolean;
};

type BrowsableQueue = { entry: RegisteredDlqDescriptor; dlqUrl: string };

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listQueue({ entry, dlqUrl }: BrowsableQueue, logsLookup: Promise<ConsumerLogs | null>) {
  const received = await browseDlqMessages(dlqUrl, { limit: PER_QUEUE_LIMIT, maxReceives: MAX_RECEIVES_PER_QUEUE });
  const ids = received.flatMap(message => (message.MessageId ? [message.MessageId] : []));
  const [{ failures, lookupFailed }, attempts, logs] = await Promise.all([
    findDlqFailures(entry.label, entry.sourceQueue, ids),
    countDlqReplayAttempts(entry.label, ids),
    logsLookup,
  ]);
  const failureById = new Map(failures.map(failure => [failure.messageId, failure]));
  return received.map(message => {
    const failure = failureById.get(message.MessageId!);
    return {
      queueLabel: entry.label,
      messageId: message.MessageId!,
      body: message.Body ?? '',
      entity: describeDlqMessage(entry, message.Body),
      sentTimestamp: message.Attributes?.SentTimestamp,
      approximateReceiveCount: message.Attributes?.ApproximateReceiveCount,
      approximateFirstReceiveTimestamp: message.Attributes?.ApproximateFirstReceiveTimestamp,
      logsUrl: messageLogsUrl(logs, message.Attributes?.SentTimestamp),
      ...(lookupFailed ? { failureLookupFailed: true } : {}),
      failure: failure ? { errorMessage: failure.errorMessage, category: failure.category } : undefined,
      recommendation: recommendForDlqMessage({
        failure,
        logs,
        replayAttempts: attempts?.get(message.MessageId!),
        replaySafety: entry.replay,
      }),
    };
  });
}

/**
 * GET /api/admin/dlq/all-messages
 *
 * Every registered DLQ's messages in one list, newest first. Each queue that holds messages is
 * browsed without hiding them (see browseDlqMessages), up to PER_QUEUE_LIMIT messages; `queues`
 * reports how many were listed against the approximate count so the UI can say when it is partial.
 * Newest first holds within what was listed: a queue over PER_QUEUE_LIMIT contributes a sample.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
  auth: 'jwtOnly',
}).get(async (req, res) => {
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  const registry = getDlqRegistry();
  // Stage-gated queues (scheduled jobs, the alarm relay) have no URL on a stage that does not create
  // them: that is "not on this stage", not a failed read, and there is nothing to browse.
  const dlqUrls = registry.map(entry => {
    try {
      return getDlqUrl(entry.label);
    } catch {
      return null;
    }
  });
  const counts = await Promise.allSettled(dlqUrls.map(async url => (url === null ? null : getQueueAttributes(url))));
  const approximateCount = (index: number) => {
    const settled = counts[index];
    return settled.status === 'fulfilled' && settled.value ? settled.value.approximateMessageCount : -1;
  };
  // A queue whose count could not be read is browsed anyway rather than silently left out.
  const toBrowse: BrowsableQueue[] = registry.flatMap((entry, index) => {
    const dlqUrl = dlqUrls[index];
    return dlqUrl !== null && approximateCount(index) !== 0 ? [{ entry, dlqUrl }] : [];
  });

  // Started before browsing and awaited per queue, so a slow lookup overlaps the SQS receives.
  const logsLookup = settleWithinBudget(
    toBrowse.map(({ entry }) => resolveConsumerLogsForSourceQueue(entry.sourceQueue)),
    CONSUMER_LOGS_BUDGET_MS
  );
  const listings = await mapWithConcurrency(toBrowse, QUEUE_CONCURRENCY, async (queue, index) => {
    const { label } = queue.entry;
    try {
      const messages = await listQueue(
        queue,
        logsLookup.then(logs => logs[index] ?? null)
      );
      return { label, messages, failed: false };
    } catch (error) {
      Logger.warn('[DLQ All Messages] Could not list queue', {
        queueLabel: label,
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
      return { label, messages: [], failed: true };
    }
  });
  const listingByLabel = new Map(listings.map(listing => [listing.label, listing]));

  const queues: QueueListing[] = registry.map((entry, index) => {
    const listing = listingByLabel.get(entry.label);
    return {
      label: entry.label,
      approximateMessageCount: approximateCount(index),
      listed: listing?.messages.length ?? 0,
      failed: listing?.failed ?? false,
    };
  });
  const messages = listings
    .flatMap(listing => listing.messages)
    .sort((a, b) => Number(b.sentTimestamp ?? 0) - Number(a.sentTimestamp ?? 0));

  Logger.info(`[DLQ All Messages] Listed ${messages.length} messages from ${toBrowse.length} queues`, {
    adminUserId,
  });
  return res.json({ messages, queues });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
