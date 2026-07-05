import { webhookAuditLogRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';

/**
 * Admin API for retrieving a single webhook audit log
 *
 * GET: Get audit log by delivery ID
 */

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

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
