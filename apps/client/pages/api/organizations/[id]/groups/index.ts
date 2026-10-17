// GET /api/organizations/:id/groups
// List an organization's groups, each with its current members.

import { organizationRepository } from '@bike4mind/database/infra';
import { groupRepository } from '@bike4mind/database/social';
import { userRepository } from '@bike4mind/database/auth';
import { organizationService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { respond } from '@server/utils/respond';
import { organizationGroupWithMembersResponseSchema } from '@bike4mind/common';
import { z } from 'zod';

const listGroupsResponseSchema = z.object({ groups: z.array(organizationGroupWithMembersResponseSchema) });

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new NotFoundError('Organization not found');

    // The org fetch, the MANAGE authorization (not Permission.read - the result exposes who is in
    // which group), and the member assembly all live in the service alongside the sibling group
    // actions (org-groups #1225). The route only extracts params and delegates.
    const groups = await organizationService.listOrganizationGroups(
      req.user,
      { organizationId },
      { db: { organizations: organizationRepository, groups: groupRepository, users: userRepository } }
    );

    return respond(res, listGroupsResponseSchema, { groups });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
