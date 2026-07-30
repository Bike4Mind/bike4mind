// GET /api/organizations/:id/groups
// List an organization's groups, each with its current member count.

import { Permission } from '@bike4mind/common';
import { groupRepository } from '@bike4mind/database/social';
import { userRepository } from '@bike4mind/database/auth';
import { Organization } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const organization = organizationId && (await Organization.findById(organizationId));
    // ForbiddenError (an HTTPError), not a bare Error: the error handler maps only HTTPError
    // subclasses, so a bare throw becomes a 500 and pages on-call for a routine 403.
    if (!organization || !req.ability!.can(Permission.read, organization)) {
      throw new ForbiddenError("Not authorized to view this organization's groups");
    }

    const groups = await groupRepository.findByOrganization(organizationId as string);
    // Member counts in a single aggregation (org-groups #1172, Phase 4) - one pass keyed by group
    // id, rather than an N+1 of per-group counts. Backed by the user_groups index.
    const counts = await userRepository.countUsersByGroupIds(groups.map(group => group.id));
    const withCounts = groups.map(group => ({ ...group, memberCount: counts[group.id] ?? 0 }));

    return res.status(200).json({ groups: withCounts });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
