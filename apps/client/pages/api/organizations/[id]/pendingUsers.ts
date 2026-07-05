import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository, userRepository, inviteRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';

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

  return res.json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
