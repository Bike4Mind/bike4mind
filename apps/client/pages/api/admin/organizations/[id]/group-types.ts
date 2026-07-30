import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database';
import { Group } from '@bike4mind/database/social';
import { User } from '@bike4mind/database/auth';
import { organizationService } from '@bike4mind/services';
import { z } from 'zod';

/**
 * PUT /api/admin/organizations/[id]/group-types - platform-admin only.
 * Sets an org's allowed group types (org-groups #1172, Phase 3): provisions a Group instance for
 * each newly-allowed type, and on revocation soft-deletes the instance and purges its id from
 * every member. All validation + the revoke purge live in `setOrganizationGroupTypes` (tested).
 *
 * DRAFT TODOs (tracked on the PR): wrap the writes in a transaction with session propagation to
 * the model-direct group/user writes, and emit a formal admin audit event for the grant/revoke.
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

    const result = await organizationService.setOrganizationGroupTypes(
      { organizationId, allowedGroupTypes: body.allowedGroupTypes },
      {
        db: {
          organizations: organizationRepository,
          groups: {
            findByOrganization: async orgId => {
              const groups = await Group.find({ organizationId: orgId }).select('_id type').lean();
              return groups.map(group => ({ id: group._id.toString(), type: group.type as string }));
            },
            create: data => Group.create(data),
            softDeleteByIds: async groupIds => {
              await Group.deleteMany({ _id: { $in: groupIds } });
            },
          },
          users: {
            // $pull each revoked group id from every user that has it. Not a $set-style repo op,
            // so it goes through the model directly.
            pullGroupsFromAll: async groupIds => {
              await User.updateMany({ groups: { $in: groupIds } }, { $pull: { groups: { $in: groupIds } } });
            },
          },
        },
        logger: req.logger,
      }
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
