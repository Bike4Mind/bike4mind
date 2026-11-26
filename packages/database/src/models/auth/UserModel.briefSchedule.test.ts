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

let userSeq = 0;
const insertUser = async (preferences: Record<string, unknown> | null) => {
  const username = `u${++userSeq}`;
  const { insertedId } = await User.collection.insertOne({ username, email: `${username}@example.com`, preferences });
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

  it('pulls an enabled schedule forward to an earlier reminder, never later', async () => {
    const userId = await insertUser(null);
    await userRepository.setBriefSchedule(userId, schedule, DUE);
    const later = new Date(DUE.getTime() + 60_000);
    expect(await userRepository.pullNextBriefAtForward(userId, later)).toBe(false);
    expect((await userRepository.getBriefSchedule(userId)).nextBriefAt).toEqual(DUE);
    const earlier = new Date(DUE.getTime() - 60_000);
    expect(await userRepository.pullNextBriefAtForward(userId, earlier)).toBe(true);
    expect((await userRepository.getBriefSchedule(userId)).nextBriefAt).toEqual(earlier);
  });

  it('does not pull forward a schedule that is off or missing', async () => {
    const off = await insertUser(null);
    await userRepository.setBriefSchedule(off, { ...schedule, enabled: false }, null);
    const none = await insertUser({ language: 'fr' });
    for (const userId of [off, none]) {
      expect(await userRepository.pullNextBriefAtForward(userId, DUE)).toBe(false);
      expect((await userRepository.getBriefSchedule(userId)).nextBriefAt).toBeNull();
    }
  });

  it('the due scan is served by the partial index', async () => {
    await User.syncIndexes();
    let filter: Record<string, unknown> | undefined;
    mongoose.set('debug', (_collection: string, method: string, query: Record<string, unknown>) => {
      if (method === 'find') filter = query;
    });
    try {
      await userRepository.findDueBriefSchedules(DUE, 10);
    } finally {
      mongoose.set('debug', false);
    }

    expect(filter).toBeDefined();
    const plan = await User.find(filter).sort({ nextBriefAt: 1 }).explain('queryPlanner');
    const winning = JSON.stringify((plan as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
    expect(winning).toContain('user_nextBriefAt');
    expect(winning).not.toContain('COLLSCAN');
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
