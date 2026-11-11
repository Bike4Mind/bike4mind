import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqRegistry, getDlqUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { buildLogsInsightsUrl, resolveConsumerLogsForSourceQueue } from '@bike4mind/server-utils/utils/dlqConsumerLogs';
import { getQueueAttributes } from '@bike4mind/server-utils/utils/sqs';
import { Logger } from '@bike4mind/observability';

const QUEUE_LOGS_WINDOW_MS = 24 * 60 * 60_000;

/**
 * GET /api/admin/dlq/queues
 *
 * Returns all DLQs with their approximate message counts, plus a Logs Insights link over the
 * last 24h of each queue's consumer logs (null when the consumer could not be resolved).
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  Logger.info(`[DLQ Queues] Fetching queue counts`, { adminUserId });

  const registry = getDlqRegistry();

  const now = Date.now();
  const [results, consumerLogs] = await Promise.all([
    // async so a registry throw for a missing DLQ URL becomes that row's -1 fallback, not a 500.
    Promise.allSettled(registry.map(async entry => getQueueAttributes(getDlqUrl(entry.label)))),
    Promise.all(registry.map(entry => resolveConsumerLogsForSourceQueue(entry.sourceQueue))),
  ]);

  const queues = results.map((result, index) => {
    const entry = registry[index];
    const logs = consumerLogs[index];
    const base = {
      label: entry.label,
      displayName: entry.displayName,
      application: entry.application,
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
      return {
        ...base,
        approximateMessageCount: result.value.approximateMessageCount,
        approximateNotVisibleCount: result.value.approximateNotVisibleCount,
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
