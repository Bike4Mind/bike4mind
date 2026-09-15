import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { IUserDocument } from '@bike4mind/common';
import { inboxRepository } from '@bike4mind/database/social';

// Returns the current user's inbox messages
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = (req.user as IUserDocument)?.id;

    if (!userId) throw new Error('User not found');

    const inbox = await inboxRepository.findByReceiverId(userId, { sort: { createdAt: -1 } });
    return res.json(inbox);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
