// GET /api/:type/invites/:id - Retrieves all pending invitations for a document

import { Invite } from '@bike4mind/database/social';
import { canViewInvite, getInviteDetails } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isValidObjectId } from '@server/utils/objectId';

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

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    const invite = await Invite.findById(id);
    // A caller who is not a named recipient or share-authorized gets the same 404 as a
    // missing invite -- a 403 would confirm the id exists.
    if (!invite || !(await canViewInvite(req.user, invite))) {
      return res.status(404).json({ message: 'Invite Not Found' });
    }

    return res.json(await getInviteDetails(invite, true));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
