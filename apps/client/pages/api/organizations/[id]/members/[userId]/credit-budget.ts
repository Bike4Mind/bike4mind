// PUT /api/organizations/:id/members/:userId/credit-budget
// Set or clear one member's monthly credit budget override (null inherits the org default).
// Billing owner, appointed org admin, or platform admin (canManageMemberCreditBudgets in @bike4mind/common).
// A sibling of index.ts rather than a new method on it: that route is gated on `datalake:share`,
// which says nothing about credit budgets.

import { ApiKeyScope, toSafeOrganization } from '@bike4mind/common';
import { organizationService } from '@bike4mind/services';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';

const bodySchema = z.object({ maxCredits: z.number().nullable() });

// `admin:*` only, for the same reason as ../../member-credit-budget.ts.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).put(
  asyncHandler<{}, unknown, unknown, { id?: string; userId?: string }>(async (req, res) => {
    const { id: organizationId, userId } = req.query;
    if (typeof organizationId !== 'string' || !organizationId || typeof userId !== 'string' || !userId) {
      throw new BadRequestError('Invalid organization or member id');
    }

    const { maxCredits } = bodySchema.parse(req.body);
    const change = await organizationService.setMemberCreditOverride(
      req.user!,
      { organizationId, userId, maxCredits },
      { db: { organizations: organizationRepository, users: userRepository } }
    );

    await recordAdminActionFromRequest(req, {
      action: 'org.member_budget.updated',
      actorScope: 'organization',
      target: { kind: 'organization', id: organizationId, displayName: change.organization.name },
      summary: 'updated a member credit budget override',
      changes: [{ field: 'maxCredits', before: change.previous, after: change.current }],
      details: { memberUserId: userId },
    });

    return res.json(toSafeOrganization(change.organization, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
