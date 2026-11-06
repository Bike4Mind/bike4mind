import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { canAccessAdmin, toSafeUser, UnauthorizedError } from '@bike4mind/common';
import { denySelfAdminAction, isSelfOrImpersonator, parseAdminActionReason } from '@server/utils/adminAudit';
import { subscriptionCancellationResponse } from '@server/billing/cancelAccountSubscriptions';
import { getApprovalPolicy, requestApproval } from '@server/admin/approvals/service';
import { deleteUserAsAdmin, deletedUserTarget } from '@server/admin/deleteUserAsAdmin';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;

    if (!req.user.isAdmin) throw new UnauthorizedError('You are not authorized to delete users');
    if (isSelfOrImpersonator(req.user, userId)) {
      await denySelfAdminAction(req, {
        action: 'user.deletion.denied',
        attempted: 'user.deleted',
        target: deletedUserTarget(userId, await userRepository.findById(userId)),
      });
    }
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const policy = await getApprovalPolicy();
    if (policy.enabled) {
      const target = await userRepository.findById(userId);
      if (canAccessAdmin(target)) {
        const pending = await requestApproval(
          req,
          {
            action: 'user.delete_admin',
            params: { userId, reason },
            summary: `delete admin account ${deletedUserTarget(userId, target).displayName}`,
            reason,
            requiredPermission: 'users:delete',
            requiresFullAdmin: true,
          },
          policy
        );
        return res.status(202).json(pending);
      }
    }

    const { result: deletedUser, subscriptionCancellation } = await deleteUserAsAdmin(req, userId, reason, undefined, {
      requireNonAdmin: policy.enabled,
    });

    return res.json({ ...toSafeUser(deletedUser), ...subscriptionCancellationResponse(subscriptionCancellation) });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
