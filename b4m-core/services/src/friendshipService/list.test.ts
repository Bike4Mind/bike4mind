import { describe, expect, it, vi } from 'vitest';
import { FriendshipStatus, IFriendshipModelAdapter, IUserDocument } from '@bike4mind/common';
import { listFriends, listPendingFriendRequests } from './list';

const user = (id: string) => ({ id, username: `user-${id}` }) as unknown as IUserDocument;

const buildAdapters = (friendships: Array<Record<string, string>>, users: IUserDocument[]) => ({
  db: {
    friendship: {
      findAllForUser: vi.fn().mockResolvedValue(friendships),
    } as unknown as IFriendshipModelAdapter,
    users: { findByIds: vi.fn().mockResolvedValue(users) },
  },
  compareId: (a: unknown, b: unknown) => String(a) === String(b),
});

describe('listFriends', () => {
  it('pairs each friendship with its own user when findByIds returns a different order', async () => {
    const friendships = [
      { id: 'f1', requester: 'me', recipient: 'a', status: FriendshipStatus.ACCEPTED },
      { id: 'f2', requester: 'b', recipient: 'me', status: FriendshipStatus.ACCEPTED },
      { id: 'f3', requester: 'me', recipient: 'c', status: FriendshipStatus.ACCEPTED },
    ];
    const adapters = buildAdapters(friendships, [user('c'), user('a'), user('b')]);

    const result = await listFriends({ userId: 'me' }, adapters);

    expect(result.map(row => [row.id, row.user.id])).toEqual([
      ['f1', 'a'],
      ['f2', 'b'],
      ['f3', 'c'],
    ]);
  });

  it('drops a friendship whose user no longer exists without shifting the others', async () => {
    const friendships = [
      { id: 'f1', requester: 'me', recipient: 'a' },
      { id: 'f2', requester: 'me', recipient: 'gone' },
      { id: 'f3', requester: 'me', recipient: 'c' },
    ];
    const adapters = buildAdapters(friendships, [user('c'), user('a')]);

    const result = await listFriends({ userId: 'me' }, adapters);

    expect(result.map(row => [row.id, row.user.id])).toEqual([
      ['f1', 'a'],
      ['f3', 'c'],
    ]);
  });
});

describe('listPendingFriendRequests', () => {
  it('pairs each request with its own requester when findByIds returns a different order', async () => {
    const pending = [
      { id: 'p1', requester: 'a', recipient: 'me' },
      { id: 'p2', requester: 'b', recipient: 'me' },
      { id: 'p3', requester: 'me', recipient: 'x' },
    ];
    const adapters = buildAdapters(pending, [user('b'), user('a')]);

    const result = await listPendingFriendRequests({ userId: 'me' }, adapters);

    expect(result.map(row => [row.id, row.user.id])).toEqual([
      ['p1', 'a'],
      ['p2', 'b'],
    ]);
  });

  it('drops a request whose requester no longer exists', async () => {
    const pending = [
      { id: 'p1', requester: 'a', recipient: 'me' },
      { id: 'p2', requester: 'gone', recipient: 'me' },
    ];
    const adapters = buildAdapters(pending, [user('a')]);

    const result = await listPendingFriendRequests({ userId: 'me' }, adapters);

    expect(result.map(row => [row.id, row.user.id])).toEqual([['p1', 'a']]);
  });
});
