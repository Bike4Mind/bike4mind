import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { userRepository } from '@bike4mind/database';
import { assertCanActOnAdminTarget, canAccessAdmin, isFullAdmin, toSafeUser } from '@bike4mind/common';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
} from '@bike4mind/server-utils/utils/adminAudit';
import { subscriptionCancellationResponse } from '@server/billing/cancelAccountSubscriptions';
import { getApprovalPolicy, requestApproval } from '@server/admin/approvals/service';
import { deleteUserAsAdmin, deletedUserTarget } from '@server/admin/deleteUserAsAdmin';

const handler = adminApi({ adminPermissions: { DELETE: 'users:delete' } }).delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;

    const target = await userRepository.findById(userId);
    if (isSelfOrImpersonator(req.user, userId)) {
      await denySelfAdminAction(req, {
        action: 'user.deletion.denied',
        attempted: 'user.deleted',
        target: deletedUserTarget(userId, target),
      });
    }
    assertCanActOnAdminTarget(req.user, target, 'delete');
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const policy = await getApprovalPolicy();
    if (policy.enabled) {
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
      // A delegate's target is re-checked too, in case it gained admin access since the check above.
      requireNonAdmin: policy.enabled || !isFullAdmin(req.user),
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
