// Accept an invitation
// POST /api/invites/[id]/accept

import { baseApi } from '@server/middlewares/baseApi';
import { filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { acceptInviteForUser, notifyInvitesRefetch } from '@server/managers/inviteResponses';

const handler = baseApi().post(async (req, res) => {
  const id = req.query.id as string;
  if (!id) {
    return res.status(400).json({ message: 'Invalid accept invite request' });
  }

  const invite = await acceptInviteForUser(req, id);

  await notifyInvitesRefetch(req.user.id, 'Accepted invite');

  // Invitee-facing: strip co-recipients' emails from the returned invite.
  return res.json(filterInviteRecipientsToSelf(invite, req.user.email));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
