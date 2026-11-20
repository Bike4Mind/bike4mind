// Refuse an invitation
// POST /api/invites/[id]/refuse

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { notifyInvitesRefetch, refuseInviteForUser } from '@server/managers/inviteResponses';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = req.query.id;

    if (!id) {
      return res.status(400).json({ message: 'Invalid refuse invite request' });
    }

    const invite = await refuseInviteForUser(req, id);

    if (!invite) {
      return res.status(404).json({ message: 'Invite not found' });
    }

    await notifyInvitesRefetch(req.user.id, 'Refused invite');

    // Invitee-facing: strip co-recipients' emails from the returned invite.
    return res.json(filterInviteRecipientsToSelf(invite, req.user.email));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
