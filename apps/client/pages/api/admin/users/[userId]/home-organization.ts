import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  assertCanActOnAdminTarget,
  isFullAdmin,
} from '@bike4mind/common';
import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

/**
 * DELETE /api/admin/users/[userId]/home-organization - clear a user's home org (`user.organizationId`).
 *
 * The home org is what a request that names no account falls back to for billing (an API key, the
 * CLI; see resolveBillingOrgId in server-utils orgAccess.ts) and the org-scoped access context, so
 * clearing it is more than a billing reset. Memberships and roles are untouched. Full admins only,
 * like the membership actions beside it on the profile. The user's own escape is
 * DELETE /api/users/[id]/organization; this is the audited admin equivalent.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { DELETE: 'users:moderate' } }).delete(
  async (req, res) => {
    if (!isFullAdmin(req.user)) throw new ForbiddenError("Only full administrators can clear a user's home org");
    const userId = req.query.userId;
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    await withTransaction(async () => {
      const user = await userRepository.findById(userId);
      if (!user) throw new NotFoundError('User not found');
      assertCanActOnAdminTarget(req.user, user, 'clear the home org of');

      const before = user.organizationId?.toString() ?? null;
      // Already clear is a no-op: no write and no audit entry.
      if (!before) return;

      // The pointer can name an org that was since deleted, so a missing name is not an error.
      const organization = await organizationRepository.findById(before);
      await organizationService.clearActiveOrganization(req.user, { userId }, { db: { users: userRepository } });

      await recordAdminActionFromRequest(req, {
        action: 'user.home_org.cleared',
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
        organizationId: before,
        summary: `cleared home organization ${organization?.name ?? before}`,
        reason,
        changes: [{ field: 'organizationId', before, after: null }],
        details: organization ? { organizationName: organization.name } : undefined,
      });
    });

    return res.status(204).end();
  }
);

export const config = { api: { externalResolver: true } };
export default handler;
