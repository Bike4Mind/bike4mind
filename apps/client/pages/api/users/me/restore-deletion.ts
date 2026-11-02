import { ForbiddenError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { restoreAccountDeletion } from '@server/accountDeletion/restoreAccountDeletion';
import { logAuthAudit } from '@server/utils/authAudit';

/**
 * Cancels the caller's pending account deletion during the grace period. Reachable by a deletion-pending
 * session (see apps/client/server/auth/deletionPendingGate.ts). Idempotent: a second call reports
 * `restored: false`.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  if (req.user.impersonatedBy) {
    throw new ForbiddenError('Cannot restore an account while impersonating its user.');
  }

  const { restored } = await restoreAccountDeletion(req.user.id);
  if (restored) {
    await logAuthAudit(req, { userId: req.user.id, event: 'account_deletion_restored', actorUserId: req.user.id });
  }
  return res.status(200).json({ restored });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
