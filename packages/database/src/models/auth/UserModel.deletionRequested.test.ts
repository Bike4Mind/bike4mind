import { describe, it, expect } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const FIRST = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-05T00:00:00.000Z');

const createUser = (name: string) => User.create({ username: name, name, email: `${name}@example.com` });

describe('UserModel self-service deletion state', () => {
  it('marks a deletion request once and keeps the first request time on a repeat', async () => {
    const user = await createUser('alice');

    expect(await userRepository.markDeletionRequested(user.id, FIRST)).toEqual({
      deletionRequestedAt: FIRST,
      newlyMarked: true,
    });
    expect(await userRepository.markDeletionRequested(user.id, LATER)).toEqual({
      deletionRequestedAt: FIRST,
      newlyMarked: false,
    });
    expect((await User.findById(user.id))?.deletionRequestedAt).toEqual(FIRST);
  });

  it('returns null when marking a user that does not exist', async () => {
    expect(await userRepository.markDeletionRequested('507f1f77bcf86cd799439011', FIRST)).toBeNull();
  });

  it('clears a request once; a second clear reports nothing to clear', async () => {
    const user = await createUser('bob');
    await userRepository.markDeletionRequested(user.id, FIRST);

    expect(await userRepository.clearDeletionRequested(user.id)).toBe(true);
    expect(await userRepository.clearDeletionRequested(user.id)).toBe(false);
    expect((await User.findById(user.id))?.deletionRequestedAt ?? null).toBeNull();
  });

  it('lists only the accounts past the cutoff, oldest first, up to the limit', async () => {
    const [oldest, older, recent] = await Promise.all([createUser('carol'), createUser('dave'), createUser('erin')]);
    await createUser('frank');
    await userRepository.markDeletionRequested(older.id, new Date('2026-01-10T00:00:00.000Z'));
    await userRepository.markDeletionRequested(oldest.id, new Date('2026-01-02T00:00:00.000Z'));
    await userRepository.markDeletionRequested(recent.id, new Date('2026-02-01T00:00:00.000Z'));
    const cutoff = new Date('2026-01-15T00:00:00.000Z');

    expect(await userRepository.findDeletionDueUserIds(cutoff, 10)).toEqual([oldest.id, older.id]);
    expect(await userRepository.findDeletionDueUserIds(cutoff, 1)).toEqual([oldest.id]);
  });
});
