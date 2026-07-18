import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { withTransaction } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { logEvent } from '@server/utils/analyticsLog';
import { OrganizationEvents, toSafeUser, toSafeUsers, toSafeOrganization } from '@bike4mind/common';
import { Request } from 'express';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';

const handler = baseApi()
  .get(async (req, res) => {
    const { id: organizationId } = req.query;

    const users = await organizationService.getUsers(
      req.user,
      { id: organizationId as string },
      { db: { organizations: organizationRepository, users: userRepository } }
    );

    return res.json(toSafeUsers(users, 'same-org'));
  })
  .post(async (req: Request<{}, {}, { name: string; email: string; level: string }, { id?: string }>, res) => {
    const { id: userId } = req.user;
    const { id: organizationId } = req.query;

    if (!organizationId) {
      throw new BadRequestError('Organization ID is required');
    }

    const { user: newMember } = await withTransaction(async () =>
      organizationService.addMember(
        req.user,
        { organizationId, ...(req.body as any) },
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

    return res.json(toSafeUser(newMember, 'same-org'));
  })
  .delete(async (req, res) => {
    // Transaction: org-membership removal and clearing the user's organizationId must
    // commit atomically, or a failure between the two leaves a stale organizationId. Mirrors addMember above.
    const organization = await withTransaction(() =>
      organizationService.leave(
        req.user,
        { ...(req.query as any) },
        { db: { organizations: organizationRepository, users: userRepository } }
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
