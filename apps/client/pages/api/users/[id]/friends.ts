import { compareMongoIds, friendshipRepository, userRepository } from '@bike4mind/database';
import { friendshipService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Request } from 'express';

const handler = baseApi().get<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
  const userId = req.query.id;

  // A user's friend list resolves to full user records (including email), so
  // only the user themselves or an admin may read it.
  if (userId !== req.user.id && !req.user.isAdmin) {
    throw new ForbiddenError('Not authorized to view this user\'s friends');
  }

  const friends = await friendshipService.listFriends(
    { userId },
    {
      db: {
        friendship: friendshipRepository,
        users: userRepository,
      },
      compareId: (id1, id2) => compareMongoIds(id1 as string, id2 as string),
    }
  );
  return res.json(friends);
});

export default handler;
