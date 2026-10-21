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

  // Pending invitees were invited by user id and have not joined, so their address is not the
  // org's to show: org admins included, since they are the ones who minted the invite. Name and
  // username identify the row, and cancelling one goes by user id. Platform admins keep the email.
  return respond(res, safeUsersResponseSchema, toSafeUsers(result, req.user!.isAdmin ? 'same-org' : 'public'));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
