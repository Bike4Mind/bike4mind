// POST /api/organizations/:id/groups
// Create a new group for the given organization

import { isKnownGroupType } from '@bike4mind/common';
import { Group } from '@bike4mind/database/social';
import { Organization } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
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
    if (!organization) throw new ForbiddenError("Not authorized to manage this organization's groups");
    // Same predicate as the membership/rename routes (assertCanManageOrgGroups): billing owner,
    // an appointed org admin, or a platform admin. NOT the org manager - a manager is deliberately
    // out of the group-management predicate, so gating on CASL Permission.update (which includes
    // managerId) was the wrong gate. Throw ForbiddenError, not a bare Error: the error handler maps
    // only HTTPError subclasses, so a bare throw becomes a 500 and pages on-call for a routine 403.
    const isOwner = organization.userId === req.user?.id;
    const isOrgAdmin = (organization.adminUserIds ?? []).includes(req.user?.id ?? '');
    if (!isOwner && !isOrgAdmin && !req.user?.isAdmin) {
      throw new ForbiddenError("Not authorized to manage this organization's groups");
    }

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
