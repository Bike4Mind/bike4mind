import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqRegistry, getDlqUrl, type RegisteredDlqDescriptor } from '@bike4mind/server-utils/utils/dlqRegistry';
import {
  buildLogsInsightsUrl,
  CONSUMER_LOGS_BUDGET_MS,
  resolveConsumerLogsForSourceQueue,
  settleWithinBudget,
} from '@bike4mind/server-utils/utils/dlqConsumerLogs';
import { getQueueAttributes } from '@bike4mind/server-utils/utils/sqs';
import { Logger } from '@bike4mind/observability';

const QUEUE_LOGS_WINDOW_MS = 24 * 60 * 60_000;
const NOT_DEPLOYED = Symbol('not-deployed');

// Overlay-contributed entries carry no help fields, so those keys are left undefined.
function queueMeta(entry: RegisteredDlqDescriptor) {
  return {
    label: entry.label,
    displayName: entry.displayName,
    application: entry.application,
    hasReplayDestination: Boolean(entry.sourceQueue),
    description: entry.description,
    replay: entry.replay,
    replayNote: entry.replayNote,
    owner: entry.owner,
  };
}

/**
 * GET /api/admin/dlq/queues
 *
 * Returns all DLQs with their approximate message counts (-1 when unreadable; a queue this stage
 * does not create also carries deployed: false), message retention and replay help, plus a
 * Logs Insights link over the last 24h of each queue's consumer logs (null when the consumer could
 * not be resolved).
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  Logger.info(`[DLQ Queues] Fetching queue counts`, { adminUserId });

  const registry = getDlqRegistry();

  // Stage-gated queues (scheduled jobs, the alarm relay) have no URL on stages that do not create
  // them, so a missing URL means "not on this stage", not a failed read.
  const dlqUrls = registry.map(entry => {
    try {
      return getDlqUrl(entry.label);
    } catch {
      return null;
    }
  });

  const now = Date.now();
  const [results, consumerLogs] = await Promise.all([
    Promise.allSettled(dlqUrls.map(async url => (url === null ? NOT_DEPLOYED : getQueueAttributes(url)))),
    settleWithinBudget(
      registry.map(entry => resolveConsumerLogsForSourceQueue(entry.sourceQueue)),
      CONSUMER_LOGS_BUDGET_MS
    ),
  ]);

  const queues = results.map((result, index) => {
    const entry = registry[index];
    const logs = consumerLogs[index];
    const base = {
      ...queueMeta(entry),
      logGroups: logs?.logGroups ?? null,
      logsUrl: logs
        ? buildLogsInsightsUrl({
            region: logs.region,
            logGroups: logs.logGroups,
            start: now - QUEUE_LOGS_WINDOW_MS,
            end: now,
          })
        : null,
    };
    if (result.status === 'fulfilled') {
      if (result.value === NOT_DEPLOYED) {
        return { ...base, deployed: false, approximateMessageCount: -1, approximateNotVisibleCount: -1 };
      }
      return {
        ...base,
        approximateMessageCount: result.value.approximateMessageCount,
        approximateNotVisibleCount: result.value.approximateNotVisibleCount,
        messageRetentionSeconds: result.value.messageRetentionSeconds,
      };
    }
    Logger.warn(`[DLQ] Failed to get attributes for ${entry.label}`, {
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    return { ...base, approximateMessageCount: -1, approximateNotVisibleCount: -1 };
  });

  const totalMessages = queues.reduce((sum, q) => sum + Math.max(q.approximateMessageCount, 0), 0);
  Logger.info(`[DLQ Queues] Returned ${queues.length} queues, ${totalMessages} total messages`, { adminUserId });

  return res.json({ queues });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
