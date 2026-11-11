import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDlqRegistry, getDlqUrl, type RegisteredDlqDescriptor } from '@bike4mind/server-utils/utils/dlqRegistry';
import { getQueueAttributes } from '@bike4mind/server-utils/utils/sqs';
import { Logger } from '@bike4mind/observability';

/**
 * GET /api/admin/dlq/queues
 *
 * Returns all DLQs with their approximate message counts and replay help.
 */
// Overlay-contributed entries carry no help fields, so those keys are left undefined.
function queueMeta(entry: RegisteredDlqDescriptor) {
  return {
    label: entry.label,
    displayName: entry.displayName,
    application: entry.application,
    description: entry.description,
    replay: entry.replay,
    replayNote: entry.replayNote,
    owner: entry.owner,
  };
}

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  Logger.info(`[DLQ Queues] Fetching queue counts`, { adminUserId });

  const registry = getDlqRegistry();

  const results = await Promise.allSettled(
    registry.map(async entry => {
      const dlqUrl = getDlqUrl(entry.label);
      const attrs = await getQueueAttributes(dlqUrl);
      return {
        ...queueMeta(entry),
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
      ...queueMeta(registry[index]),
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
