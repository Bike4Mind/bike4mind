import { FriendshipStatus, IFriendshipModelAdapter, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listFriendsSchema = z.object({
  userId: z.string(),
});

type ListFriendsParameters = z.infer<typeof listFriendsSchema>;

interface ListFriendsAdapters {
  db: {
    friendship: IFriendshipModelAdapter;
    users: {
      findByIds: (ids: string[]) => Promise<IUserDocument[]>;
    };
  };
  compareId: (id1: unknown, id2: unknown) => boolean;
}

export async function listFriends(
  parameters: ListFriendsParameters,
  { db, compareId }: ListFriendsAdapters
): Promise<Array<{ id: string; user: IUserDocument }>> {
  const { userId } = secureParameters(parameters, listFriendsSchema);
  const friendships = await db.friendship.findAllForUser(userId, { status: FriendshipStatus.ACCEPTED });
  const friendUserIds = friendships.map(friendship => {
    if (compareId(friendship.requester, userId)) return friendship.recipient;
    return friendship.requester;
  });

  const friends = await db.users.findByIds(friendUserIds as string[]);

  return friendships.map((friendship, index) => ({
    id: friendship.id,
    user: friends[index],
  }));
}

const listPendingFriendRequestsSchema = z.object({
  userId: z.string(),
});

type ListPendingFriendRequestsParameters = z.infer<typeof listPendingFriendRequestsSchema>;

export async function listPendingFriendRequests(
  parameters: ListPendingFriendRequestsParameters,
  { db, compareId }: ListFriendsAdapters
): Promise<Array<{ id: string; user: IUserDocument }>> {
  const { userId } = secureParameters(parameters, listPendingFriendRequestsSchema);
  const pendingRequests = await db.friendship.findAllForUser(userId, { status: FriendshipStatus.PENDING });
  // Make sure the requester is not the current user
  const filteredPendingRequests = pendingRequests.filter(friendship => compareId(friendship.recipient, userId));

  const requesterIds = filteredPendingRequests.map(friendship => friendship.requester);
  const requesters = await db.users.findByIds(requesterIds as string[]);

  return filteredPendingRequests.map((friendship, index) => ({
    id: friendship.id,
    user: requesters[index],
  }));
}
