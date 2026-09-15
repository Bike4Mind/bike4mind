import { z } from 'zod';
import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { withTransaction } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { logEvent } from '@server/utils/analyticsLog';
import {
  OrganizationEvents,
  toSafeUser,
  toSafeUsers,
  toSafeOrganization,
  safeUserResponseSchema,
  safeUsersResponseSchema,
} from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { Request } from 'express';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { groupRepository } from '@bike4mind/database/social';

// No `force` here, deliberately. The service still accepts a seat-ceiling override for the
// platform-admin migration path, but a client must never be able to set it and enroll past the
// seats the org has paid for. Zod strips unknown keys, so a request body carrying `force` has it
// dropped here and it never reaches the service.
//
// Not `.strict()`: this route's declared body type is `{name, email, level}`, so rejecting unknown
// keys would 400 callers sending fields the route has always ignored. Stripping is what closes the
// bypass; rejecting would only change who else breaks.
const addMemberBodySchema = z.object({
  userId: z.string().optional(),
  email: z.string().optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    const { id: organizationId } = req.query;

    const users = await organizationService.getUsers(
      req.user,
      { id: organizationId as string },
      { db: { organizations: organizationRepository, users: userRepository } }
    );

    return respond(res, safeUsersResponseSchema, toSafeUsers(users, 'same-org'));
  })
  .post(async (req: Request<{}, {}, { name: string; email: string; level: string }, { id?: string }>, res) => {
    const { id: userId } = req.user;
    const { id: organizationId } = req.query;

    if (!organizationId) {
      throw new BadRequestError('Organization ID is required');
    }

    const body = addMemberBodySchema.parse(req.body);
    const { user: newMember } = await withTransaction(async () =>
      organizationService.addMember(
        req.user,
        { organizationId, ...body },
        {
          db: {
            organizations: organizationRepository,
            users: userRepository,
          },
          logger: req.logger,
        }
      )
    );

    await logEvent(
      {
        userId,
        type: OrganizationEvents.ADD_ORG_MEMBER,
        metadata: {
          organizationId,
          memberEmail: newMember.email || '',
          memberLevel: newMember.level,
        },
      },
      { ability: req.ability }
    );

    return respond(res, safeUserResponseSchema, toSafeUser(newMember, 'same-org'));
  })
  .delete(async (req, res) => {
    // Transaction: org-membership removal and clearing the user's organizationId must
    // commit atomically, or a failure between the two leaves a stale organizationId. Mirrors addMember above.
    const organization = await withTransaction(() =>
      organizationService.leave(
        req.user,
        { ...(req.query as any) },
        {
          db: {
            organizations: organizationRepository,
            users: userRepository,
            groups: groupRepository,
          },
        }
      )
    );

    await logEvent(
      {
        userId: req.user.id,
        type: OrganizationEvents.LEAVE_ORG,
        metadata: {
          userId: req.user.id,
          organizationId: organization.id,
        },
      },
      { ability: req.ability }
    );

    return res.json(toSafeOrganization(organization, { userId: req.user.id, isAdmin: req.user.isAdmin }));
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
