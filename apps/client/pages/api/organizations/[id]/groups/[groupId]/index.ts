// PATCH /api/organizations/:id/groups/:groupId
// Rename a group instance. Billing owner, org admin, or platform admin.

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database/infra';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { z } from 'zod';

const bodySchema = z.object({ name: z.string().trim().min(1).max(120) });

const handler = baseApi().patch(
  asyncHandler<{}, unknown, unknown, { id?: string; groupId?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const groupId = req.query.groupId;
    if (!organizationId || !groupId) throw new BadRequestError('Organization id and group id are required');

    // Let a ZodError propagate to the central errorHandler (maps it to 422 via fromZodError) rather
    // than hand-rolling a divergent 400 here.
    const { name } = bodySchema.parse(req.body);

    // Authorization + the "group belongs to this org" invariant live in the service (shared with
    // the membership writes and covered by its tests), so this route only extracts and delegates.
    const updated = await organizationService.renameGroup(
      req.user!,
      { organizationId, groupId, name },
      { db: { organizations: organizationRepository, groups: groupRepository } }
    );
    // Null only if the group vanished between the service's existence check and the update (race).
    if (!updated) throw new NotFoundError('Group not found');
    return res.status(200).json({ group: updated });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
