// POST /api/organizations/:id/groups
// Create a new group for the given organization

import { Permission, isKnownGroupType } from '@bike4mind/common';
import { Group } from '@bike4mind/database/social';
import { Organization } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import z from 'zod';

const ApiOrganizationsGroupsCreateRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  // Groups are typed (org-groups #1172). The type must be a known catalog key AND allowed for
  // this org; Phase 3's grant route is the real provisioning path, this direct route stays gated.
  type: z.string(),
});

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const organization = organizationId && (await Organization.findById(organizationId));
    if (!organization || !req.ability!.can(Permission.update, organization)) throw new Error('Unauthorized');

    const { name, description, type } = ApiOrganizationsGroupsCreateRequestSchema.parse(req.body ?? {});
    if (!isKnownGroupType(type)) {
      throw new BadRequestError(`Unknown group type "${type}"`);
    }
    if (!organization.allowedGroupTypes?.includes(type)) {
      throw new BadRequestError(`Organization is not allowed the group type "${type}"`);
    }

    const group = await Group.create({ name, description: description ?? '', type, organizationId });
    return res.status(200).json({ group });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
