import { webhookAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { Logger } from '@bike4mind/observability';

/**
 * Admin API for retrieving a single webhook audit log
 *
 * GET: Get audit log by delivery ID
 */

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const { deliveryId } = req.query;

  if (!deliveryId || typeof deliveryId !== 'string') {
    throw new BadRequestError('Delivery ID is required');
  }

  const log = await webhookAuditLogRepository.findByDeliveryId(deliveryId);

  if (!log) {
    // Log the actual ID for debugging, but don't expose it in the error message (info leakage prevention)
    Logger.warn('[Admin] Webhook audit log not found', { deliveryId, adminUserId: req.user?.id });
    throw new NotFoundError('Webhook audit log not found');
  }

  Logger.info('[Admin] Retrieved webhook audit log', {
    deliveryId,
    adminUserId: req.user?.id,
  });

  return res.json(log);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
