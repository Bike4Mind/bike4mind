import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { z } from 'zod';

/**
 * PUT /api/admin/organizations/[id]/group-types - platform-admin only.
 * Sets an org's allowed group types (org-groups #1172, Phase 3): provisions a Group instance for
 * each newly-allowed type, and on revocation soft-deletes the instance and purges its id from
 * every member. All validation + the revoke purge live in `setOrganizationGroupTypes` (tested).
 *
 * Wrapped in withTransaction: provisioning, soft-deletes, the member purge, and the org write
 * all commit together (or roll back together) - the repositories join the session automatically
 * via transactionAsyncLocalStorage. Grant/revoke is audit-logged after the transaction commits.
 */
const bodySchema = z.object({
  allowedGroupTypes: z.array(z.string()).max(20),
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    // ZodError propagates to the central errorHandler (422 via fromZodError). No hand-rolled 400.
    const body = bodySchema.parse(req.body);

    const result = await withTransaction(() =>
      organizationService.setOrganizationGroupTypes(
        { organizationId, allowedGroupTypes: body.allowedGroupTypes },
        {
          db: { organizations: organizationRepository, groups: groupRepository, users: userRepository },
          logger: req.logger,
        }
      )
    );

    // Audit AFTER commit: "who changed which org's group types" is a question legal will ask
    // once a type reaches confidential data. Best-effort - a logging failure must not fail the
    // already-committed change.
    await recordAdminActionFromRequest(req, {
      action: 'org.group_types.updated',
      target: { kind: 'organization', id: organizationId, displayName: organizationId },
      summary: 'updated allowed group types',
      details: { ...result },
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
