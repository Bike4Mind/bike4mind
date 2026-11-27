import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { activityRepository, Friendship, friendshipRepository, User, userRepository } from '@bike4mind/database';
import { friendshipService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { FriendshipEvents } from '@bike4mind/common';

const CreateFriendRequestSchema = z.object({
  email: z.email(),
  message: z.string().optional(),
});

// Per user: rateLimit keys on req.user.id because it runs after baseApi's auth.
const FRIEND_REQUEST_RATE_LIMIT = { limit: 20, windowMs: 60 * 1000, bucket: 'friends-request' } as const;

const handler = baseApi()
  .use(rateLimit(FRIEND_REQUEST_RATE_LIMIT))
  .post(outboundActionGate(), async (req, res) => {
    const { email, message } = CreateFriendRequestSchema.parse(req.body);
    const userId = req.user.id;

    const user = await userRepository.findByEmail(email);
    if (!user) throw new NotFoundError('Provided email does not belong to any user');

    const friendRequest = await friendshipService.sendFriendRequest(
      { requesterId: userId, recipientId: user.id, message },
      {
        db: {
          friendship: friendshipRepository,
        },
      }
    );

    if (friendRequest) {
      await Promise.all([
        activityRepository.createActivity(
          'friend.requested',
          { type: Friendship.modelName, id: friendRequest.id },
          { type: User.modelName, id: userId },
          { type: User.modelName, id: user.id }
        ),
        logEvent(
          {
            userId,
            type: FriendshipEvents.FRIENDSHIP_REQUEST,
            metadata: {
              requesterId: userId,
              receiverId: user.id,
            },
          },
          { ability: req.ability }
        ),
      ]);
    }

    return res.status(201).end();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
