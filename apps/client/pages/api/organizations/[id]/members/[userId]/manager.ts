// PUT    /api/organizations/:id/members/:userId/manager - make this member a manager
// DELETE /api/organizations/:id/members/:userId/manager - remove them as a manager
// Billing owner or platform admin only (organizationService.setOrganizationManager). The per-member
// twin of PUT ../../admins.ts, which replaces the whole list and so loses one of two concurrent edits.

import { ApiKeyScope, toSafeOrganization } from '@bike4mind/common';
import { organizationService } from '@bike4mind/services';
import { organizationRepository } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const setManager = (isManager: boolean) =>
  asyncHandler<{}, unknown, unknown, { id?: string; userId?: string }>(async (req, res) => {
    const { id: organizationId, userId } = req.query;
    if (typeof organizationId !== 'string' || !organizationId || typeof userId !== 'string' || !userId) {
      throw new BadRequestError('Invalid organization or member id');
    }

    const change = await organizationService.setOrganizationManager(
      req.user!,
      { organizationId, userId, isManager },
      { db: { organizations: organizationRepository } }
    );

    // Same action as the full-replace route, so the org audit trail reads one event family for
    // "who changed the managers" whichever surface made the change.
    await recordAdminActionFromRequest(req, {
      action: 'org.admins.updated',
      actorScope: 'organization',
      target: { kind: 'organization', id: organizationId, displayName: change.organization.name },
      summary: isManager ? 'made a member an organization manager' : 'removed an organization manager',
      changes: [{ field: 'adminUserIds', before: change.previousAdminUserIds, after: change.adminUserIds }],
      details: { memberUserId: userId },
    });

    return res.json(toSafeOrganization(change.organization, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
  });

// `admin:*` only, like the sibling credit-budget route: appointing a manager is org administration.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .put(setManager(true))
  .delete(setManager(false));

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
