import { ADMIN_ERASURE_PREVIEWED_ACTION, ApiKeyScope } from '@bike4mind/common';
import { findErasureTarget, previewAdminErasure } from '@server/dataSubject/adminErasure';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * The erasure dry run: per collection, how many documents naming the user an erasure deletes, removes
 * them from and keeps (with why). Counts only. POST, not GET, because it takes a reason and is audited
 * before the walk.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:delete' },
})
  .use(csrfProtection())
  .post(async (req, res) => {
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const { user, auditTarget } = await findErasureTarget(req.user, req.query.userId);
    await recordAdminActionFromRequest(req, {
      action: ADMIN_ERASURE_PREVIEWED_ACTION,
      target: auditTarget,
      summary: 'previewed a data subject erasure',
      reason,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await previewAdminErasure(user));
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
