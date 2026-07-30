// GET /api/organizations/:id/groups
// List an organization's groups, each with its current member count.

import { Permission } from '@bike4mind/common';
import { groupRepository } from '@bike4mind/database/social';
import { userRepository } from '@bike4mind/database/auth';
import { Organization } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const organization = organizationId && (await Organization.findById(organizationId));
    if (!organization || !req.ability!.can(Permission.read, organization)) throw new Error('Unauthorized');

    const groups = await groupRepository.findByOrganization(organizationId as string);
    // Member count = users whose groups[] contains this group id (org-groups #1172, Phase 4).
    const withCounts = await Promise.all(
      groups.map(async group => ({ ...group, memberCount: await userRepository.count({ groups: group.id }) }))
    );

    return res.status(200).json({ groups: withCounts });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
