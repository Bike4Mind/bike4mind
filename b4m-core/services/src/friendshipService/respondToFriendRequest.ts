import { FriendshipStatus, IFriendshipDocument, IFriendshipModelAdapter } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const respondToFriendRequestSchema = z.object({
  id: z.string(),
  /** The user ID of the recipient of the friend request */
  userId: z.string(),
  accept: z.boolean(),
});

type RespondToFriendRequestParameters = z.infer<typeof respondToFriendRequestSchema>;

interface RespondToFriendRequestAdapters {
  db: {
    friendship: IFriendshipModelAdapter;
  };
  compareId: (id1: unknown, id2: unknown) => boolean;
}

export async function respondToFriendRequest(
  parameters: RespondToFriendRequestParameters,
  { db, compareId }: RespondToFriendRequestAdapters
): Promise<IFriendshipDocument | null> {
  const { id, userId, accept } = secureParameters(parameters, respondToFriendRequestSchema);

  const friendship = await db.friendship.findById(id);
  if (!friendship) throw new NotFoundError('Friend request not found');

  // Ensure the user is the recipient of the friend request
  if (!compareId(friendship.recipient, userId)) throw new NotFoundError('Friend request not found');

  const status = accept ? FriendshipStatus.ACCEPTED : FriendshipStatus.REJECTED;
  return db.friendship.updateStatus(id, status);
}
