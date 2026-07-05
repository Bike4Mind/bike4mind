// POST /api/organizations/:id/groups
// Create a new group for the given organization

import { Permission } from '@bike4mind/common';
import { Group } from '@bike4mind/database/social';
import { Organization } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import z from 'zod';

const ApiOrganizationsGroupsCreateRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const organization = organizationId && (await Organization.findById(organizationId));
    if (!organization || !req.ability!.can(Permission.update, organization)) throw new Error('Unauthorized');

    const { name, description } = ApiOrganizationsGroupsCreateRequestSchema.parse(req.body ?? {});

    const group = await Group.create({ name, description, organizationId });
    return res.status(200).json({ group });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
