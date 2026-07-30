// GET /api/organizations/:id/groups
// List an organization's groups, each with its current members.

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
    // TODO(#1178, Phase 6): this returns memberIds to any Permission.read member. Fine while group
    // keys are generic and confer nothing, but once a group gates a confidential capability, tighten
    // this to the manage predicate (owner/org-admin/platform-admin) so membership is not enumerable
    // by a plain member. The only current callers (admin card + Groups tab) are already manager-gated.
    if (!organization || !req.ability!.can(Permission.read, organization)) {
      throw new ForbiddenError("Not authorized to view this organization's groups");
    }

    const groups = await groupRepository.findByOrganization(organizationId as string);
    // Members per group in a single aggregation (org-groups #1172, Phase 4) - one pass keyed by
    // group id, backed by the user_groups index (no N+1 of per-group reads). The management UI
    // needs the member ids, not just a count, to render and unassign current members - the
    // safe-user shape carries no groups[] field, so this route is the only place that membership
    // surfaces. memberCount is derived from the ids so the two can never disagree.
    const membersByGroup = await userRepository.findUserIdsByGroupIds(groups.map(group => group.id));
    const withMembers = groups.map(group => {
      const memberIds = membersByGroup[group.id] ?? [];
      return { ...group, memberIds, memberCount: memberIds.length };
    });

    return res.status(200).json({ groups: withMembers });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
