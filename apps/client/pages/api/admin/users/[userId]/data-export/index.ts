import { v4 as uuidv4 } from 'uuid';
import { ADMIN_DATA_EXPORT_FAILED_ACTION, ADMIN_DATA_EXPORT_REQUESTED_ACTION, ApiKeyScope } from '@bike4mind/common';
import { cacheRepository } from '@bike4mind/database';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { requireStepUp } from '@server/auth/stepUp';
import { denySelfDataExport, findDataExportTarget, listAdminDataExports } from '@server/dataSubject/adminDataExports';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

// One build per target at a time: the worker's Lambda runs for up to 15 minutes (infra/queues.ts).
const EXPORT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Data subject exports (access/portability requests) of one user. POST queues one on the self-serve
 * export worker (apps/workers/src/queueHandlers/accountDataExport.ts) with the registry records added;
 * GET lists the recent ones. The request is audited before it is queued, so an export that cannot be
 * recorded is never built; one that is recorded but cannot be queued is audited as failed.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'users:export', POST: 'users:export' },
})
  .use(csrfProtection())
  .get(async (req, res) => {
    const { user } = await findDataExportTarget(req.user, req.query.userId);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ exports: await listAdminDataExports(user.id) });
  })
  .post(async (req, res) => {
    await requireStepUp(req);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const target = await findDataExportTarget(req.user, req.query.userId);
    await denySelfDataExport(req, target, ADMIN_DATA_EXPORT_REQUESTED_ACTION);
    const { user, auditTarget } = target;

    // Counted here rather than by the rateLimit middleware so a failed enqueue can give the slot back.
    const rateKey = `rate-limit:${user.id}:admin-data-export`;
    const quota = await cacheRepository.tryIncrementWithinLimitFixedWindow(rateKey, 1, EXPORT_WINDOW_MS);
    if (!quota.success) {
      const retryAfterSeconds = Math.max(1, Math.ceil((quota.expiresAt.getTime() - Date.now()) / 1000));
      const inFlight = (await listAdminDataExports(user.id)).find(entry => entry.status.state === 'building');
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({
        error: 'An export of this user was requested in the last 15 minutes.',
        exportJobId: inFlight?.exportJobId ?? null,
      });
    }

    const exportJobId = uuidv4();
    try {
      await recordAdminActionFromRequest(req, {
        action: ADMIN_DATA_EXPORT_REQUESTED_ACTION,
        target: auditTarget,
        summary: 'requested a data subject export',
        reason,
        details: { exportJobId },
      });
    } catch (error) {
      await releaseSlot(req, rateKey);
      throw error;
    }
    try {
      await sendToQueue(getSourceQueueUrl('accountDataExportQueue'), {
        exportJobId,
        userId: user.id,
        requestedBy: req.user.id,
      });
    } catch (error) {
      req.logger.error('[Admin Data Export] Failed to queue job', { exportJobId, error });
      await releaseSlot(req, rateKey);
      await recordAdminActionFromRequest(req, {
        action: ADMIN_DATA_EXPORT_FAILED_ACTION,
        target: auditTarget,
        summary: 'could not queue a data subject export',
        details: { exportJobId },
      });
      return res.status(500).json({ error: 'Failed to start the export. Please try again.', exportJobId });
    }
    return res.status(202).json({ exportJobId });
  });

async function releaseSlot(req: { logger: { error: (message: string, meta?: object) => void } }, rateKey: string) {
  try {
    await cacheRepository.decrementCounter(rateKey);
  } catch (error) {
    req.logger.error('[Admin Data Export] Failed to release the rate limit slot', { error });
  }
}

export const config = {
  api: { externalResolver: true },
};

export default handler;
