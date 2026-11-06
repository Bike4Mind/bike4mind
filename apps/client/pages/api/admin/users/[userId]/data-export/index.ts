import { v4 as uuidv4 } from 'uuid';
import { ADMIN_DATA_EXPORT_REQUESTED_ACTION, ApiKeyScope } from '@bike4mind/common';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { requireStepUp } from '@server/auth/stepUp';
import { findDataExportTarget, listAdminDataExports } from '@server/dataSubject/adminDataExports';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * Data subject exports (access/portability requests) of one user. POST queues one on the self-serve
 * export worker (apps/workers/src/queueHandlers/accountDataExport.ts) with the registry records added;
 * GET lists the recent ones. The request is audited before it is queued, so an export that cannot be
 * recorded is never built.
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
    const { user, auditTarget } = await findDataExportTarget(req.user, req.query.userId);

    const exportJobId = uuidv4();
    await recordAdminActionFromRequest(req, {
      action: ADMIN_DATA_EXPORT_REQUESTED_ACTION,
      target: auditTarget,
      summary: 'requested a data subject export',
      reason,
      details: { exportJobId },
    });
    await sendToQueue(getSourceQueueUrl('accountDataExportQueue'), {
      exportJobId,
      userId: user.id,
      requestedBy: req.user.id,
    });
    return res.status(202).json({ exportJobId });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
