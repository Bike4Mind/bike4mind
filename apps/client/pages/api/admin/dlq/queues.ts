import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, BadRequestError } from '@server/utils/errors';
import { getDlqRegistry, getDlqUrl } from '@server/utils/dlqRegistry';
import { getQueueAttributes } from '@server/utils/sqs';
import { Logger } from '@bike4mind/observability';

/**
 * GET /api/admin/dlq/queues
 *
 * Returns all DLQs with their approximate message counts.
 */
const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  Logger.info(`[DLQ Queues] Fetching queue counts`, { adminUserId });

  const registry = getDlqRegistry();

  const results = await Promise.allSettled(
    registry.map(async entry => {
      const dlqUrl = getDlqUrl(entry.label);
      const attrs = await getQueueAttributes(dlqUrl);
      return {
        label: entry.label,
        displayName: entry.displayName,
        application: entry.application,
        approximateMessageCount: attrs.approximateMessageCount,
        approximateNotVisibleCount: attrs.approximateNotVisibleCount,
      };
    })
  );

  const queues = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    Logger.warn(`[DLQ] Failed to get attributes for ${registry[index].label}`, {
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    return {
      label: registry[index].label,
      displayName: registry[index].displayName,
      application: registry[index].application,
      approximateMessageCount: -1,
      approximateNotVisibleCount: -1,
    };
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
