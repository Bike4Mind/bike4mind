import {
  ACCOUNT_DELETION_ORG_OWNER_CODE,
  ADMIN_ERASURE_REQUESTED_ACTION,
  ApiKeyScope,
  ConflictError,
  ForbiddenError,
} from '@bike4mind/common';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { requireStepUp } from '@server/auth/stepUp';
import { findErasureTarget, readAdminErasureState } from '@server/dataSubject/adminErasure';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requestAdminErasure } from '@server/users/accountDeletion';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * Data subject erasure of one user. GET reads where it stands. POST locks the account down, marks it
 * for deletion at once and queues the account purge (apps/workers/src/queueHandlers/accountErasure.ts);
 * the request is audited before anything changes. If the queue cannot be reached, the daily deletion
 * sweep picks the account up instead, since it is already due.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'users:delete', POST: 'users:delete' },
})
  .use(csrfProtection())
  .get(async (req, res) => {
    const { user } = await findErasureTarget(req.user, req.query.userId);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await readAdminErasureState(user.id));
  })
  .post(async (req, res) => {
    await requireStepUp(req);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const { user, auditTarget } = await findErasureTarget(req.user, req.query.userId);
    if (user.id === req.user.id) throw new ForbiddenError('You cannot erase your own account.');

    // Refused requests are not audited as requested; requestAdminErasure re-checks both atomically.
    const current = await readAdminErasureState(user.id);
    if (current.state !== 'none') throw new ConflictError('This account already has a deletion pending.');
    if (current.ownedOrganizations.length > 0) {
      throw new ConflictError('Transfer or delete the organizations this user owns before erasing their data.', {
        code: ACCOUNT_DELETION_ORG_OWNER_CODE,
        organizations: current.ownedOrganizations,
      });
    }

    await recordAdminActionFromRequest(req, {
      action: ADMIN_ERASURE_REQUESTED_ACTION,
      target: auditTarget,
      summary: 'requested a data subject erasure',
      reason,
    });
    await requestAdminErasure(req, user.id);

    let queued = true;
    try {
      await sendToQueue(getSourceQueueUrl('accountErasureQueue'), { userId: user.id });
    } catch (error) {
      queued = false;
      req.logger.error(`Failed to queue the erasure of user ${user.id}; the daily sweep will run it: ${String(error)}`);
    }
    return res.status(202).json({ queued });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
