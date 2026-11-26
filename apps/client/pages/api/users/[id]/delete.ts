import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireStepUp } from '@server/auth/stepUp';
import { userRepository } from '@bike4mind/database';
import {
  ACCOUNT_DELETION_ORG_OWNER_CODE,
  ApiKeyScope,
  assertCanActOnAdminTarget,
  canAccessAdmin,
  ConflictError,
  isFullAdmin,
  toSafeUser,
} from '@bike4mind/common';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
} from '@bike4mind/server-utils/utils/adminAudit';
import { subscriptionCancellationResponse } from '@bike4mind/server-utils/billing/cancelAccountSubscriptions';
import { getApprovalPolicy, requestApproval } from '@server/admin/approvals/service';
import { readAdminErasureState } from '@server/dataSubject/adminErasure';
import { deleteUserAsAdmin, deletedUserTarget } from '@server/admin/deleteUserAsAdmin';

// Same gate as the erasure route (pages/api/admin/users/[userId]/erasure/index.ts), which runs the same action.
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { DELETE: 'users:delete' },
})
  .use(csrfProtection())
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      await requireStepUp(req);
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
          const current = await readAdminErasureState(target!.id);
          if (current.state !== 'none') throw new ConflictError('This account already has a deletion pending.');
          if (current.ownedOrganizations.length > 0) {
            throw new ConflictError('Transfer or delete the organizations this user owns first.', {
              code: ACCOUNT_DELETION_ORG_OWNER_CODE,
              organizations: current.ownedOrganizations,
            });
          }
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

      const {
        user: deletedUser,
        subscriptionCancellation,
        queued,
      } = await deleteUserAsAdmin(req, userId, reason, undefined, {
        // A delegate's target is re-checked too, in case it gained admin access since the check above.
        requireNonAdmin: policy.enabled || !isFullAdmin(req.user),
      });

      return res.json({
        ...toSafeUser(deletedUser),
        ...subscriptionCancellationResponse(subscriptionCancellation),
        queued,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
