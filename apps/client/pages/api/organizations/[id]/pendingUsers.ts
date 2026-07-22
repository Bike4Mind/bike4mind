import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository, userRepository, inviteRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { toSafeUsers, safeUsersResponseSchema } from '@bike4mind/common';
import { respond } from '@server/utils/respond';

const handler = baseApi().get(async (req, res) => {
  const result = await organizationService.listPendingUsers(
    req.user!,
    { organizationId: req.query.id as string },
    {
      db: {
        organizations: organizationRepository,
        users: userRepository,
        invites: inviteRepository,
      },
    }
  );

  return respond(res, safeUsersResponseSchema, toSafeUsers(result, 'same-org'));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
