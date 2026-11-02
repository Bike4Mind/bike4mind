import { ForbiddenError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { requestAccountDeletion } from '@server/accountDeletion/requestAccountDeletion';
import { logAuthAudit } from '@server/utils/authAudit';

/**
 * Self-service account deletion: schedules the caller's own account for deletion after the grace period.
 * jwtOnly: an API key must never be able to delete its owner's account. Idempotent (see
 * requestAccountDeletion); the caller's session is revoked with every other, so the client signs out.
 */
const handler = baseApi({ auth: 'jwtOnly' }).delete(async (req, res) => {
  // An admin acting as the user has their own delete path (pages/api/users/[id]/delete.ts).
  if (req.user.impersonatedBy) {
    throw new ForbiddenError('Cannot delete an account while impersonating its user.');
  }

  const result = await requestAccountDeletion(req.user.id, { logger: req.logger });
  if (result.newlyRequested) {
    await logAuthAudit(req, {
      userId: req.user.id,
      event: 'account_deletion_requested',
      actorUserId: req.user.id,
      metadata: { canceledSubscriptions: result.canceledSubscriptions },
    });
  }

  return res.status(200).json({
    deletionRequestedAt: result.deletionRequestedAt.toISOString(),
    deletionScheduledFor: result.deletionScheduledFor.toISOString(),
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
