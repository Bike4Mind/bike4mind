// GET /api/:type/:id - Retrieves a single invitation by its redemption key

import { inviteRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { canViewInvite, getInviteDetails, filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

interface IParams {
  type?: string;
  id?: string;
}

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
    const id = req.query.id;

    if (!id) {
      return res.status(400).json({ message: 'Invite Share request' });
    }

    // Same door as the sibling at pages/api/invites/[id], and for the same reason: this route reads
    // an invite from a redemption key, so a tokenized LINK invite must not be openable by guessing
    // ObjectIds around a real one. The shape check the resolver applies replaces the isValidObjectId
    // guard that used to live here, which would have rejected every bearer token outright.
    const invite = await sharingService.resolveRedeemableInvite(id, { db: { invites: inviteRepository } });
    // A caller who is not a named recipient or share-authorized gets the same 404 as a
    // missing invite -- a 403 would confirm the id exists.
    if (!invite || !(await canViewInvite(req.user, invite))) {
      return res.status(404).json({ message: 'Invite Not Found' });
    }

    // Invitee-facing view: strip other recipients' addresses, keep the caller's own. Matches the
    // sibling at pages/api/invites/[id] and the other invitee-facing routes; passing the gate above
    // means the caller is one named recipient, not that they may read the whole recipient list.
    const details = await getInviteDetails(invite, true);
    return res.json(filterInviteRecipientsToSelf(details, req.user.email));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
