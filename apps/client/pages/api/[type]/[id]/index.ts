// GET /api/:type/invites/:id - Retrieves all pending invitations for a document

import { Invite } from '@bike4mind/database/social';
import { getInviteDetails } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import mongoose from 'mongoose';

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

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    const invite = await Invite.findById(id);
    if (!invite) {
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
