import { z } from 'zod';
import { AdminPermissionsSchema, ApiKeyScope, ForbiddenError, isFullAdmin } from '@bike4mind/common';
import {
  User,
  withTransaction,
  prepareAdminMutationLock,
  lockAdminMutations,
  assertCanRemoveFullAdmin,
} from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireStepUp } from '@server/auth/stepUp';
import { isSelfOrImpersonator, parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { respond } from '@server/utils/respond';

const permissionsSchema = z.object({ adminPermissions: AdminPermissionsSchema, isAdmin: z.boolean() });
const bodySchema = permissionsSchema.extend({ reason: z.string().trim().min(1).max(500) }).strict();
const querySchema = z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i) });

const api = adminApi({
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { PUT: 'settings:manage' },
});
const handler = api.put(
  asyncHandler(async (req, res) => {
    const { userId } = querySchema.parse(req.query);
    const body = bodySchema.parse(req.body);
    const reason = parseAdminActionReason(body.reason);
    if (isSelfOrImpersonator(req.user, userId)) throw new ForbiddenError('Cannot change your own admin permissions.');
    if (req.apiKeyInfo) throw new ForbiddenError('Admin permission changes require a signed-in session.');
    await requireStepUp(req);
    await prepareAdminMutationLock();
    const updated = await withTransaction(async () => {
      await lockAdminMutations();
      const target = await User.findById(userId).select('isAdmin adminPermissions name username email').lean();
      if (!target) throw new NotFoundError('User not found');
      const after = { isAdmin: body.isAdmin, adminPermissions: [...new Set(body.adminPermissions)] };
      if (!isFullAdmin(after)) await assertCanRemoveFullAdmin(userId);
      await User.updateOne({ _id: userId }, { $set: after });
      await recordAdminActionFromRequest(req, {
        action: 'user.permissions.updated',
        target: { kind: 'user', id: userId, displayName: target.name || target.username || target.email || userId },
        summary: 'updated admin permissions',
        reason,
        changes: [
          { field: 'isAdmin', before: !!target.isAdmin, after: after.isAdmin },
          { field: 'adminPermissions', before: target.adminPermissions ?? [], after: after.adminPermissions },
        ],
      });
      return after;
    });
    return respond(res, permissionsSchema, updated);
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
