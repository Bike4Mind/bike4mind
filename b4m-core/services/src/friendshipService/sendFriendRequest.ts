import { FriendshipStatus, IFriendshipModelAdapter } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const sendFriendRequestSchema = z.object({
  requesterId: z.string(),
  recipientId: z.string(),
  message: z.string().optional(),
});

type SendFriendRequestParameters = z.infer<typeof sendFriendRequestSchema>;

interface SendFriendRequestAdapters {
  db: {
    friendship: IFriendshipModelAdapter;
  };
}

export async function sendFriendRequest(parameters: SendFriendRequestParameters, { db }: SendFriendRequestAdapters) {
  const { requesterId, recipientId } = secureParameters(parameters, sendFriendRequestSchema);

  const existing = await db.friendship.findByUsers(requesterId, recipientId);
  if (existing) {
    switch (existing.status) {
      case FriendshipStatus.PENDING:
        // If the request is pending, throw an error so that it won't create a new activity
        throw new BadRequestError('You already sent a friend request to this user');
      case FriendshipStatus.ACCEPTED:
        throw new BadRequestError('Users are already friends');
      case FriendshipStatus.REJECTED:
        // If the request was rejected, delete the existing friendship and create a new one
        await db.friendship.deleteById(existing.id);
        break;
      case FriendshipStatus.BLOCKED:
        throw new BadRequestError('One of the users has blocked the other');
    }
  }

  return await db.friendship.create({
    requester: requesterId,
    recipient: recipientId,
    status: FriendshipStatus.PENDING,
  });
}
