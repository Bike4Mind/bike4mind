import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await User.collection.deleteMany({});
});

const schedule = { enabled: true, timeOfDay: '08:00', days: [1, 2, 3, 4, 5], timeZone: 'America/New_York' };
const DUE = new Date('2026-11-19T13:00:00.000Z');

const insertUser = async (preferences: Record<string, unknown> | null) => {
  const { insertedId } = await User.collection.insertOne({ username: 'u', email: 'u@example.com', preferences });
  return insertedId.toString();
};

describe('userRepository brief schedule', () => {
  it('reads null for a user with no preferences document', async () => {
    const userId = await insertUser(null);
    expect(await userRepository.getBriefSchedule(userId)).toEqual({ schedule: null, nextBriefAt: null });
  });

  it('writes the schedule and due time together, even when preferences was null', async () => {
    const userId = await insertUser(null);
    await userRepository.setBriefSchedule(userId, schedule, DUE);
    expect(await userRepository.getBriefSchedule(userId)).toEqual({ schedule, nextBriefAt: DUE });
  });

  it('keeps the other preferences', async () => {
    const userId = await insertUser({ language: 'fr', pushNotifications: { brief_ready: false } });
    await userRepository.setBriefSchedule(userId, schedule, DUE);
    const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    expect(raw?.preferences).toMatchObject({ language: 'fr', pushNotifications: { brief_ready: false } });
  });

  it('turning the schedule off keeps it but removes the due time', async () => {
    const userId = await insertUser(null);
    await userRepository.setBriefSchedule(userId, schedule, DUE);
    await userRepository.setBriefSchedule(userId, { ...schedule, enabled: false }, null);
    const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    expect(raw).not.toHaveProperty('nextBriefAt');
    expect(raw?.preferences.briefSchedule).toEqual({ ...schedule, enabled: false });
  });

  it('declares the partial due-time index', () => {
    expect(User.schema.indexes()).toContainEqual([
      { nextBriefAt: 1 },
      expect.objectContaining({
        name: 'user_nextBriefAt',
        partialFilterExpression: { nextBriefAt: { $type: 'date' } },
      }),
    ]);
  });
});
