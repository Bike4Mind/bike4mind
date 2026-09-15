import { activityRepository, compareMongoIds, Friendship, friendshipRepository, User } from '@bike4mind/database';
import { friendshipService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import { logEvent } from '@server/utils/analyticsLog';
import { FriendshipEvents } from '@bike4mind/common';

export const ResponseFriendRequestSchema = z.object({
  accept: z.boolean(),
});

const handler = baseApi().patch(async (req, res) => {
  const userId = req.user.id;
  const friendshipId = req.query.id as string;
  const { accept } = ResponseFriendRequestSchema.parse(req.body);

  const friendship = await friendshipService.respondToFriendRequest(
    { userId, id: friendshipId, accept },
    {
      db: {
        friendship: friendshipRepository,
      },
      compareId: (id1, id2) => compareMongoIds(id1 as string, id2 as string),
    }
  );
  if (friendship) {
    await Promise.all([
      activityRepository.createActivity(
        'friend.accepted',
        { type: Friendship.modelName, id: friendshipId },
        { type: User.modelName, id: userId },
        { type: User.modelName, id: friendship.requester.toString() }
      ),
      logEvent(
        accept
          ? {
              userId,
              type: FriendshipEvents.FRIENDSHIP_ACCEPT,
              metadata: {
                accepterId: userId,
                requesterId: friendship.requester.toString(),
              },
            }
          : {
              userId,
              type: FriendshipEvents.FRIENDSHIP_REJECT,
              metadata: {
                rejecterId: userId,
                requesterId: friendship.requester.toString(),
              },
            },
        { ability: req.ability }
      ),
    ]);
  }

  return res.status(204).end();
});

export default handler;
