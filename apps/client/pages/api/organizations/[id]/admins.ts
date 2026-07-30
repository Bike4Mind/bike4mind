// PUT /api/organizations/:id/admins
// Set the org's appointed admins (adminUserIds). Billing owner or platform admin only -
// an org admin cannot appoint further admins (org-groups #1172 authorization matrix).

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database/infra';
import { z } from 'zod';

const bodySchema = z.object({ adminUserIds: z.array(z.string().min(1)).max(50) });

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    let adminUserIds: string[];
    try {
      ({ adminUserIds } = bodySchema.parse(req.body));
    } catch (error) {
      if (error instanceof z.ZodError) throw new BadRequestError('adminUserIds must be an array of user ids');
      throw error;
    }
    adminUserIds = [...new Set(adminUserIds)];

    const organization = await organizationRepository.findById(organizationId);
    if (!organization) throw new NotFoundError('Organization not found');

    const isOwner = organization.userId === req.user?.id;
    if (!isOwner && !req.user?.isAdmin) {
      throw new ForbiddenError('Only the billing owner or a platform admin can set org admins');
    }

    // An appointed admin must be a member of the org - don't reference outsiders.
    const memberIds = new Set(organization.users.map(member => member.userId));
    const notMembers = adminUserIds.filter(userId => !memberIds.has(userId));
    if (notMembers.length > 0) {
      throw new BadRequestError(`Not organization members: ${notMembers.join(', ')}`);
    }

    const updated = await organizationRepository.update({ id: organizationId, adminUserIds });
    return res.status(200).json({ adminUserIds: updated?.adminUserIds ?? adminUserIds });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
