import { activityRepository, compareMongoIds, Friendship, friendshipRepository, User } from '@bike4mind/database';
import { friendshipService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { FriendshipEvents } from '@bike4mind/common';

/**
 * API endpoint for un-friending a user.
 */
const handler = baseApi().delete(async (req, res) => {
  const friendshipId = req.query.id as string;
  const userId = req.user.id;

  const friendship = await friendshipService.unfriend(
    { friendshipId, userId },
    {
      db: { friendship: friendshipRepository },
      compareId: (id1, id2) => compareMongoIds(id1 as string, id2 as string),
    }
  );

  await Promise.all([
    activityRepository.createActivity(
      'friend.removed',
      { type: Friendship.modelName, id: friendshipId },
      { type: User.modelName, id: userId },
      { type: User.modelName, id: friendship.requester.toString() }
    ),
    logEvent(
      {
        userId,
        type: FriendshipEvents.FRIENDSHIP_CANCEL,
        metadata: {
          cancellerId: userId,
          otherUserId:
            userId === friendship.requester.toString()
              ? friendship.recipient.toString()
              : friendship.requester.toString(),
        },
      },
      { ability: req.ability }
    ),
  ]);

  return res.status(204).end();
});

export default handler;
