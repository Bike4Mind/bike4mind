import { BadRequestError, NotFoundError, assertCanActOnAdminTarget } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';
import { clearAccountDeletion } from '@server/users/accountDeletion';

/**
 * POST /api/admin/users/[userId]/cancel-deletion - clear a pending account deletion on the user's
 * behalf, through the same path as DELETE /api/account/deletion (including the cancelled email).
 * Restores access only: keys, subscriptions and published pages revoked at scheduling stay revoked.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'users:delete' } }).post(async (req, res) => {
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

  const user = await userRepository.findById(userId);
  if (isSelfOrImpersonator(req.user, userId)) {
    await denySelfAdminAction(req, {
      action: 'user.deletion.denied',
      attempted: 'user.deletion.cancelled',
      target: { kind: 'user', id: userId, displayName: user?.name || user?.username || user?.email || userId },
    });
  }
  if (!user) throw new NotFoundError('User not found');
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
  assertCanActOnAdminTarget(req.user, user, 'cancel deletion for');

  await clearAccountDeletion(req, {
    userId: user.id,
    actorUserId: req.user.id,
    recordInTransaction: async cleared => {
      await recordAdminActionFromRequest(req, {
        action: 'user.deletion.cancelled',
        target: { kind: 'user', id: user.id, displayName: user.name || user.username || user.email || user.id },
        summary: 'cancelled the scheduled account deletion',
        reason,
        changes: [
          {
            field: 'deletion',
            before: { scheduledFor: cleared.scheduledFor, source: cleared.source, requestedAt: cleared.requestedAt },
            after: null,
          },
        ],
      });
    },
  });

  return res.status(204).end();
});

export const config = { api: { externalResolver: true } };
export default handler;
