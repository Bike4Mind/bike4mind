// PUT /api/organizations/:id/members/:userId/role - give this member a role ({ role }: manager,
// billingManager or member). Who may assign what is canAssignOrgRole, enforced by
// organizationService.setOrganizationMemberRole. Owner moves only through transfer-ownership.

import { ASSIGNABLE_ORG_ROLES, toSafeOrganization } from '@bike4mind/common';
import { organizationService } from '@bike4mind/services';
import { organizationRepository } from '@bike4mind/database/infra';
import { withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';

const bodySchema = z.object({ role: z.enum(ASSIGNABLE_ORG_ROLES) });

const setRole = asyncHandler<{}, unknown, unknown, { id?: string; userId?: string }>(async (req, res) => {
  const { id: organizationId, userId } = req.query;
  if (typeof organizationId !== 'string' || !organizationId || typeof userId !== 'string' || !userId) {
    throw new BadRequestError('Invalid organization or member id');
  }
  const body = bodySchema.safeParse(req.body);
  if (!body.success) throw new BadRequestError('Role must be manager, billingManager or member');

  // The audit write is strict, so it joins the transaction: a failed audit rolls the change back. The
  // transaction also retries on a concurrent write to the org, so `canAssignOrgRole` and the audit's
  // `before` are always judged on the role the write actually replaced.
  const change = await withTransaction(async () => {
    const result = await organizationService.setOrganizationMemberRole(
      req.user!,
      { organizationId, userId, role: body.data.role },
      { db: { organizations: organizationRepository } }
    );
    // A no-op is not audited. Organization-scoped, so it also lands in the team's own audit trail.
    if (result.changed) {
      await recordAdminActionFromRequest(req, {
        action: 'org.member.role_changed',
        actorScope: 'organization',
        target: { kind: 'organization', id: organizationId, displayName: result.organization.name },
        summary: `changed a member's organization role to ${result.role}`,
        changes: [{ field: 'role', before: result.previousRole, after: result.role }],
        details: { memberUserId: userId, organizationName: result.organization.name },
      });
    }
    return result;
  });

  return res.json(toSafeOrganization(change.organization, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
});

// First-party only (`jwtOnly`), like the sibling transfer-ownership route: a new handler that took
// API keys would need a v1 contract (scripts/check-contract-gate.sh).
const handler = baseApi({ auth: 'jwtOnly' }).put(setRole);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
