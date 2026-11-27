import type { Request } from 'express';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  assertCanActOnAdminTarget,
  isFullAdmin,
  organizationMemberRole,
} from '@bike4mind/common';
import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

/** GET body: the raw pointer, which GET /api/users/[id] serves as null once the user left or the org is gone. */
export type AdminHomeOrganization = {
  organizationId: string | null;
  organizationName: string | null;
  isMember: boolean;
};

const readAdminTarget = (req: Request): { userId: string; actor: NonNullable<Request['user']> } => {
  const actor = req.user;
  if (!actor || !isFullAdmin(actor)) throw new ForbiddenError("Only full administrators can manage a user's home org");
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');
  return { userId, actor };
};

/**
 * GET / DELETE /api/admin/users/[userId]/home-organization - read or clear a user's home org
 * (`user.organizationId`).
 *
 * The home org is what a request that names no account falls back to for billing (an API key, the
 * CLI; see resolveBillingOrgId in server-utils orgAccess.ts) and the org-scoped access context, so
 * clearing it is more than a billing reset. Memberships and roles are untouched. Full admins only,
 * like the membership actions beside it on the profile. The user's own escape is
 * DELETE /api/users/[id]/organization; this is the audited admin equivalent.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { GET: 'users:moderate', DELETE: 'users:moderate' },
})
  .get(async (req, res) => {
    const { userId } = readAdminTarget(req);
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const organizationId = user.organizationId?.toString() ?? null;
    const organization = organizationId ? await organizationRepository.findById(organizationId) : null;
    const body: AdminHomeOrganization = {
      organizationId,
      organizationName: organization?.name ?? null,
      isMember: organization ? organizationMemberRole(organization, userId) !== null : false,
    };
    return res.json(body);
  })
  .delete(async (req, res) => {
    const { userId, actor } = readAdminTarget(req);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    await withTransaction(async () => {
      const user = await userRepository.findById(userId);
      if (!user) throw new NotFoundError('User not found');
      assertCanActOnAdminTarget(actor, user, 'clear the home org of');

      const before = user.organizationId?.toString() ?? null;
      // Already clear is a no-op: no write and no audit entry.
      if (!before) return;

      // The pointer can name an org that was since deleted, so a missing name is not an error.
      const organization = await organizationRepository.findById(before);
      await organizationService.clearActiveOrganization(actor, { userId }, { db: { users: userRepository } });

      await recordAdminActionFromRequest(req, {
        action: 'user.home_org.cleared',
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username ?? user.id },
        organizationId: before,
        summary: `cleared home organization ${organization?.name ?? before}`,
        reason,
        changes: [{ field: 'organizationId', before, after: null }],
        details: organization ? { organizationName: organization.name } : undefined,
      });
    });

    return res.status(204).end();
  });

export const config = { api: { externalResolver: true } };
export default handler;
