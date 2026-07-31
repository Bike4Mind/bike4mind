// GET /api/organizations/:id/groups
// List an organization's groups, each with its current members.

import { groupRepository } from '@bike4mind/database/social';
import { userRepository } from '@bike4mind/database/auth';
import { Organization } from '@bike4mind/database/infra';
import { organizationService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const organization = organizationId && (await Organization.findById(organizationId));
    if (!organization) throw new NotFoundError('Organization not found');
    // The MANAGE predicate, not Permission.read: this route returns memberIds, and every org
    // member holds read (addMember writes permissions: [read]), so a read gate would let any
    // member enumerate who is in which group - resolvable to names via the public profile route.
    // Shares the single predicate with the group write routes rather than re-deriving it here.
    organizationService.assertCanManageOrgGroups(req.user, organization);

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
