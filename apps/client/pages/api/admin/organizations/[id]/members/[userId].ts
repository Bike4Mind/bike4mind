import type { Request } from 'express';
import { z } from 'zod';
import {
  BadRequestError,
  NotFoundError,
  OrganizationEvents,
  orgAclRowConfersMembership,
  organizationMemberRole,
} from '@bike4mind/common';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  groupRepository,
  organizationRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { adminApi } from '@server/middlewares/adminApi';
import { logEventSafe } from '@bike4mind/server-utils/utils/analyticsLog';
import { parseAdminActionReason, recordAdminActionFromRequest, userAuditTarget } from '@server/utils/adminAudit';
import { reportAndNotifyKeptPersonalLakeShares } from '@server/utils/keptPersonalLakeSharesNotifier';
import { assertFullAdminForMembership } from '@server/organizations/adminMembership';

const RoleSchema = z.object({ role: z.enum(['manager', 'member']) });

const readParams = (req: Request) => {
  const { id, userId } = req.query;
  if (typeof id !== 'string' || !id || typeof userId !== 'string' || !userId) {
    throw new BadRequestError('Organization and user id required');
  }
  return { organizationId: id, userId };
};

const loadMembership = async (organizationId: string, userId: string) => {
  const organization = await organizationRepository.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');
  const role = organizationMemberRole(organization, userId);
  if (!role) throw new NotFoundError(`They are not a member of ${organization.name}.`);
  return { organization, role };
};

/** Removes a member, or changes them between member and manager, from the admin user profile. */
const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { DELETE: 'users:moderate', PATCH: 'users:moderate' },
})
  .delete(async (req, res) => {
    assertFullAdminForMembership(req.user);
    const { organizationId, userId } = readParams(req);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const organization = await withTransaction(async () => {
      const { organization, role } = await loadMembership(organizationId, userId);
      if (role === 'owner') {
        throw new BadRequestError(
          'Cannot remove the organization owner; transfer organization ownership first, then remove them.'
        );
      }
      const updated = await organizationService.revokeAccess(
        req.user,
        { id: organizationId, userId },
        {
          db: {
            organizations: organizationRepository,
            users: userRepository,
            groups: groupRepository,
            dataLakes: dataLakeRepository,
            dataLakeAccessGrants: dataLakeAccessGrantRepository,
            ...lakeConfigAuditDb,
          },
          logger: req.logger,
        }
      );
      await recordAdminActionFromRequest(req, {
        action: 'org.member.removed',
        target: await userAuditTarget(userId),
        organizationId,
        summary: `removed from organization ${organization.name}`,
        reason,
        details: { organizationName: organization.name, role },
      });
      return updated;
    });

    // After the commit, as on the org's own removal route, so a retried transaction cannot mail twice.
    const personalLakeSharesKept = await reportAndNotifyKeptPersonalLakeShares(userId, organization, req.logger);
    await logEventSafe(
      { userId: req.user.id, type: OrganizationEvents.REMOVE_ORG_MEMBER, metadata: { organizationId, userId } },
      { ability: req.ability },
      req.logger,
      organizationId
    );

    return res.json({ organizationId, userId, personalLakeSharesKept });
  })
  .patch(async (req, res) => {
    assertFullAdminForMembership(req.user);
    const { organizationId, userId } = readParams(req);
    const parsed = RoleSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Role must be manager or member');
    const { role: next } = parsed.data;
    const reason = parseAdminActionReason((req.body as { reason?: unknown }).reason);

    await withTransaction(async () => {
      const { organization, role } = await loadMembership(organizationId, userId);
      if (role === 'owner') throw new BadRequestError("The owner's role can't be changed.");
      if (role === next) throw new BadRequestError(`They are already a ${next} of ${organization.name}.`);
      // Same appointment rule as organizations/[id]/admins.ts: a manager needs a row that confers membership.
      const row = organization.users.find(member => member.userId === userId);
      if (next === 'manager' && !(row && orgAclRowConfersMembership(row))) {
        throw new BadRequestError('Only a member with read access can be made a manager.');
      }

      const adminUserIds =
        next === 'manager'
          ? [...(organization.adminUserIds ?? []), userId]
          : (organization.adminUserIds ?? []).filter(id => id !== userId);
      await organizationRepository.update({ id: organizationId, adminUserIds });
      await recordAdminActionFromRequest(req, {
        action: 'org.member.role_changed',
        target: await userAuditTarget(userId),
        organizationId,
        summary: `changed organization role in ${organization.name} to ${next}`,
        reason,
        changes: [{ field: 'role', before: role, after: next }],
        details: { organizationName: organization.name },
      });
    });

    return res.json({ organizationId, userId, role: next });
  });

export const config = { api: { externalResolver: true } };
export default handler;
