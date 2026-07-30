// PATCH /api/organizations/:id/groups/:groupId
// Rename a group instance. Billing owner, org admin, or platform admin.

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database/infra';
import { groupRepository } from '@bike4mind/database/social';
import { z } from 'zod';

const bodySchema = z.object({ name: z.string().trim().min(1).max(120) });

const handler = baseApi().patch(
  asyncHandler<{}, unknown, unknown, { id?: string; groupId?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const groupId = req.query.groupId;
    if (!organizationId || !groupId) throw new BadRequestError('Organization id and group id are required');

    let name: string;
    try {
      ({ name } = bodySchema.parse(req.body));
    } catch (error) {
      if (error instanceof z.ZodError) throw new BadRequestError('A non-empty name is required');
      throw error;
    }

    const organization = await organizationRepository.findById(organizationId);
    if (!organization) throw new NotFoundError('Organization not found');

    const isOwner = organization.userId === req.user?.id;
    const isOrgAdmin = (organization.adminUserIds ?? []).includes(req.user?.id ?? '');
    if (!isOwner && !isOrgAdmin && !req.user?.isAdmin) {
      throw new ForbiddenError('Not authorized to manage this organization’s groups');
    }

    const group = await groupRepository.findById(groupId);
    if (!group) throw new NotFoundError('Group not found');
    // Invariant: the group must belong to the org in the path (no cross-tenant rename).
    if (group.organizationId !== organizationId) {
      throw new BadRequestError('Group does not belong to this organization');
    }

    const updated = await groupRepository.update({ id: groupId, name });
    return res.status(200).json({ group: updated });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
