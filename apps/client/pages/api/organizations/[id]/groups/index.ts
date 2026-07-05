// GET /api/organizations/:id/groups
// Index route to get all groups for the given organization

import { Permission } from '@bike4mind/common';
import { Group } from '@bike4mind/database/social';
import { Organization } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const organization = organizationId && (await Organization.findById(organizationId));
    if (!organization || !req.ability!.can(Permission.read, organization)) throw new Error('Unauthorized');

    const groups = await Group.find({ organizationId });
    return res.status(200).json({ groups });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
