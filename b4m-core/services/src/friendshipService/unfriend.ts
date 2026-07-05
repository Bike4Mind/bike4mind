import { IFriendshipModelAdapter } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const unfriendSchema = z.object({
  friendshipId: z.string(),
  /** The user ID of the user who wants to unfriend the other user */
  userId: z.string(),
});

type UnfriendParameters = z.infer<typeof unfriendSchema>;

interface UnfriendAdapters {
  db: {
    friendship: IFriendshipModelAdapter;
  };
  compareId: (id1: unknown, id2: unknown) => boolean;
}

export async function unfriend(parameters: UnfriendParameters, { db, compareId }: UnfriendAdapters) {
  const { friendshipId, userId } = secureParameters(parameters, unfriendSchema);

  const friendship = await db.friendship.findById(friendshipId);
  if (!friendship) throw new NotFoundError('Users are not friends');

  // Ensure the user is part of the friendship
  if (!compareId(friendship.requester, userId) && !compareId(friendship.recipient, userId)) {
    throw new NotFoundError('Users are not friends');
  }

  await db.friendship.deleteById(friendshipId);
  return friendship;
}
