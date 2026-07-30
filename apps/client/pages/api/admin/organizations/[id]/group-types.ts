import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
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

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestError(error.issues.map(e => `${e.path.join('.') || 'value'}: ${e.message}`).join('; '));
      }
      throw error;
    }

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
    await logAuditEvent(
      {
        userId: req.user!.id,
        action: AdminOrgAuditEvents.ORG_GROUP_TYPES_UPDATED,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || 'unknown',
        metadata: { organizationId, ...result },
      },
      req.logger
    );

    res.status(200).json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
