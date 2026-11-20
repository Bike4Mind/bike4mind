import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { z } from 'zod';

/**
 * PUT /api/admin/organizations/[id]/group-types - needs settings:manage.
 * Sets an org's allowed group types (org-groups #1172, Phase 3): provisions a Group instance for
 * each newly-allowed type, and on revocation soft-deletes the instance and purges its id from
 * every member. All validation + the revoke purge live in `setOrganizationGroupTypes` (tested).
 *
 * Wrapped in withTransaction: provisioning, soft-deletes, the member purge, and the org write
 * all commit together (or roll back together) - the repositories join the session automatically
 * via transactionAsyncLocalStorage. The audit entry commits with the change.
 */
const bodySchema = z.object({
  allowedGroupTypes: z.array(z.string()).max(20),
});

const handler = adminApi({ requiredScopes: [ApiKeyScope.ADMIN], adminPermissions: { PUT: 'settings:manage' } }).put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    // ZodError propagates to the central errorHandler (422 via fromZodError). No hand-rolled 400.
    const body = bodySchema.parse(req.body);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const result = await withTransaction(async () => {
      const updated = await organizationService.setOrganizationGroupTypes(
        { organizationId, allowedGroupTypes: body.allowedGroupTypes },
        {
          db: { organizations: organizationRepository, groups: groupRepository, users: userRepository },
          logger: req.logger,
        }
      );

      await recordAdminActionFromRequest(req, {
        action: 'org.group_types.updated',
        target: { kind: 'organization', id: organizationId, displayName: organizationId },
        summary: 'updated allowed group types',
        reason,
        details: { ...updated },
      });
      return updated;
    });

    res.status(200).json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
