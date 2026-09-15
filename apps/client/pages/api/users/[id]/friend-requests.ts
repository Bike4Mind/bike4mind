import { compareMongoIds, friendshipRepository, userRepository } from '@bike4mind/database';
import { friendshipService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(async (req, res) => {
  const userId = req.user.id;

  const friends = await friendshipService.listPendingFriendRequests(
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
