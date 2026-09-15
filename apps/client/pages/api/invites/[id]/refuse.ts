// Refuse an invitation
// POST /api/invites/[id]/refuse

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { sendToClient } from '@server/websocket/utils';
import { sharingService } from '@bike4mind/services';
import { inviteRepository } from '@bike4mind/database';
import { Resource } from 'sst';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = req.query.id;

    if (!id) {
      return res.status(400).json({ message: 'Invalid refuse invite request' });
    }

    // Public-ness (link vs email invite) is derived from invite state in the service;
    // no client-supplied flag is trusted for the recipient check.
    const invite = await sharingService.refuseWholeInvite(req.user, { id }, { db: { invites: inviteRepository } });

    if (!invite) {
      return res.status(404).json({ message: 'Invite not found' });
    }

    // trigger refetch on inbox
    const wsEndpoint = Resource.websocket.managementEndpoint;
    await sendToClient(req.user.id, wsEndpoint, {
      action: 'invites_refetch',
      status: 'Refused invite',
    });

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
