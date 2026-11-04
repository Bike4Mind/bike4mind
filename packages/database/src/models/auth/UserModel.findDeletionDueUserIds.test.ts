import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await User.deleteMany({});
});

const NOW = new Date('2026-11-04T00:00:00.000Z');

const makeUser = async (scheduledFor?: Date) => {
  const user = await User.create({
    username: `user-${Math.random()}`,
    name: 'Test User',
    ...(scheduledFor && {
      deletion: { requestedAt: new Date(scheduledFor.getTime() - 1000), scheduledFor, source: 'self' },
    }),
  });
  return String(user._id);
};

describe('UserRepository.findDeletionDueUserIds', () => {
  it('lists only accounts scheduled at or before now, oldest first', async () => {
    const exactlyDue = await makeUser(NOW);
    const oldest = await makeUser(new Date('2026-10-01T00:00:00.000Z'));
    await makeUser(new Date(NOW.getTime() + 1));
    await makeUser();

    await expect(userRepository.findDeletionDueUserIds(NOW, 10)).resolves.toEqual([oldest, exactlyDue]);
  });

  it('caps the list at the limit', async () => {
    const oldest = await makeUser(new Date('2026-10-01T00:00:00.000Z'));
    await makeUser(new Date('2026-10-02T00:00:00.000Z'));

    await expect(userRepository.findDeletionDueUserIds(NOW, 1)).resolves.toEqual([oldest]);
  });

  it('is served by the deletion index', async () => {
    await makeUser(new Date('2026-10-01T00:00:00.000Z'));
    await User.syncIndexes();

    const plan = await User.find({ 'deletion.scheduledFor': { $type: 'date', $lte: NOW } })
      .sort({ 'deletion.scheduledFor': 1 })
      .explain('queryPlanner');
    const winning = JSON.stringify((plan as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
    expect(winning).toContain('user_deletion_scheduledFor');
    expect(winning).not.toContain('"SORT"');
  });
});
