// List all invites associated with a user
// GET /api/invites

import { getPendingInvitesForUser } from '@server/managers/sharingManager';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(async (req, res) => {
  const invites = await getPendingInvitesForUser(req.ability!);
  return res.json(invites);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
