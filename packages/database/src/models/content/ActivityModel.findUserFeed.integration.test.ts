import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import Activity, { activityRepository } from './ActivityModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('ActivityRepository.findUserFeed', () => {
  it('pages over activities sharing a createdAt with each one appearing exactly once', async () => {
    const userId = 'user-1';
    const createdAt = new Date(Date.UTC(2026, 0, 1));
    const docs = Array.from({ length: 7 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      key: `key-${i}`,
      trackableType: 'Session',
      trackableId: `s-${i}`,
      ownerType: 'User',
      ownerId: userId,
      createdAt,
    }));
    await Activity.collection.insertMany(docs);
    const expected = docs.map(d => String(d._id)).sort((a, b) => b.localeCompare(a));

    const ids: string[] = [];
    for (let skip = 0; skip < docs.length + 3; skip += 3) {
      const { activities, totalCount } = await activityRepository.findUserFeed(userId, {}, skip, 3);
      expect(totalCount).toBe(docs.length);
      ids.push(...activities.map(a => String(a._id)));
    }
    expect(ids).toEqual(expected);
  });
});
