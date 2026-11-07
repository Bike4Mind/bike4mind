import { BadRequestError, NotFoundError, assertCanActOnAdminTarget, canAccessAdmin } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { denySelfAdminAction, isSelfOrImpersonator, parseAdminActionReason } from '@server/utils/adminAudit';
import { getApprovalPolicy, requestApproval } from '@server/admin/approvals/service';
import { ScheduleDeletionSchema, scheduleDeletionAsAdmin } from '@server/admin/scheduleDeletionAsAdmin';

/**
 * POST /api/admin/users/[userId]/schedule-deletion - schedule the account deletion for a user who
 * asked by email and cannot sign in. Same lockdown, 14-day grace, email and purge as the self-serve
 * request; the verification note is the audit reason, and `receivedAt` (when the request email
 * arrived) becomes the deletion's `requestedAt`. The purge date counts from now, not from receipt.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'users:delete' } }).post(async (req, res) => {
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

  const user = await userRepository.findById(userId);
  if (isSelfOrImpersonator(req.user, userId)) {
    await denySelfAdminAction(req, {
      action: 'user.deletion.denied',
      attempted: 'user.deletion.scheduled',
      target: { kind: 'user', id: userId, displayName: user?.name || user?.username || user?.email || userId },
    });
  }
  if (!user) throw new NotFoundError('User not found');
  const parsedBody = ScheduleDeletionSchema.safeParse(req.body);
  if (!parsedBody.success) {
    throw new BadRequestError(parsedBody.error.issues[0]?.message ?? 'Invalid request body: expected { receivedAt }');
  }
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
  assertCanActOnAdminTarget(req.user, user, 'schedule deletion for');

  const params = { userId: user.id, receivedAt: parsedBody.data.receivedAt, reason };
  const policy = await getApprovalPolicy();
  if (policy.enabled && canAccessAdmin(user)) {
    const pending = await requestApproval(
      req,
      {
        action: 'user.schedule_admin_deletion',
        params,
        summary: `schedule deletion for admin ${user.name || user.username || user.email || user.id}`,
        reason,
        requiredPermission: 'users:delete',
        requiresFullAdmin: true,
      },
      policy
    );
    return res.status(202).json(pending);
  }
  const result = await scheduleDeletionAsAdmin(req, params, undefined, { requireNonAdmin: policy.enabled });
  return res.status(202).json(result);
});

export const config = { api: { externalResolver: true } };
export default handler;
