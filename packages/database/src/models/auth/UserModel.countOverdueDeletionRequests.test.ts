import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { overdueDeletionRequestFilter, User, userRepository } from './UserModel';

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

const NOW = new Date('2026-11-17T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const cutoff = new Date(NOW.getTime() - 25 * DAY);

const makeUser = (requestedDaysAgo?: number) =>
  User.create({
    username: `user-${Math.random()}`,
    name: 'Test User',
    ...(requestedDaysAgo !== undefined && {
      deletion: {
        requestedAt: new Date(NOW.getTime() - requestedDaysAgo * DAY),
        scheduledFor: new Date(NOW.getTime() - (requestedDaysAgo - 14) * DAY),
        source: 'self',
      },
    }),
  });

describe('UserRepository.countOverdueDeletionRequests', () => {
  it('counts an open request older than the cutoff', async () => {
    await makeUser(26);
    await expect(userRepository.countOverdueDeletionRequests(cutoff)).resolves.toBe(1);
  });

  it('does not count a fresh request or an account with no request', async () => {
    await makeUser(3);
    await makeUser();
    await expect(userRepository.countOverdueDeletionRequests(cutoff)).resolves.toBe(0);
  });

  it('does not count a cancelled request, or one that completed (its row is gone)', async () => {
    const cancelled = await makeUser(30);
    await User.updateOne({ _id: cancelled._id }, { $set: { deletion: null } });
    const completed = await makeUser(30);
    await User.deleteOne({ _id: completed._id });

    await expect(userRepository.countOverdueDeletionRequests(cutoff)).resolves.toBe(0);
  });

  it('counts a request exactly at the cutoff', async () => {
    await makeUser(25);
    await expect(userRepository.countOverdueDeletionRequests(cutoff)).resolves.toBe(1);
  });

  it('is served by the deletion index', async () => {
    await makeUser(26);
    await User.syncIndexes();

    const plan = await User.find(overdueDeletionRequestFilter(cutoff)).explain('queryPlanner');
    const winning = JSON.stringify((plan as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
    expect(winning).toContain('user_deletion_scheduledFor');
    expect(winning).not.toContain('COLLSCAN');
  });
});
