// GET /api/organizations/:id/groups
// List an organization's groups, each with its current members.

import { organizationRepository } from '@bike4mind/database/infra';
import { groupRepository } from '@bike4mind/database/social';
import { userRepository } from '@bike4mind/database/auth';
import { organizationService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { respond } from '@server/utils/respond';
import { organizationGroupWithMembersResponseSchema } from '@bike4mind/common';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { withTransaction } from '@bike4mind/database';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';

const listGroupsResponseSchema = z.object({ groups: z.array(organizationGroupWithMembersResponseSchema) });

const createHandler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id?.toLowerCase();
    if (!organizationId) throw new NotFoundError('Organization not found');
    const { type } = z
      .object({ type: z.string().trim().min(1).max(100) })
      .strict()
      .parse(req.body);
    const result = await withTransaction(async () => {
      const result = await organizationService.createStandardGroup(
        req.user,
        { organizationId, type },
        { db: { organizations: organizationRepository, groups: groupRepository, users: userRepository } }
      );
      await recordOrganizationAuditEvent({
        organizationId,
        actorUserId: req.user.impersonatedBy ?? req.user.id,
        action: 'policy.updated',
        targetId: `group-type:${type}`,
      });
      return result;
    });
    res.status(200).json(result);
  })
);

const listHandler = baseApi().get(
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

// Choose authentication before an API key can be validated or metered.
const handler = (req: Request, res: Response) =>
  (req.method?.toUpperCase() === 'POST' ? createHandler : listHandler)(req, res);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
