import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';
import { User } from './UserModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Session.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Session.collection.deleteMany({});
  await User.collection.deleteMany({});
});

const COUNT = 7;
const PAGE = 3;

/** Every notebook shares one lastUpdated and one name, so only the _id tiebreak orders them. */
const seed = async () => {
  const userId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, username: 'paging-user', email: 'paging@example.com' });
  const lastUpdated = new Date(Date.UTC(2026, 0, 1));
  const docs = Array.from({ length: COUNT }, () => ({
    _id: new mongoose.Types.ObjectId(),
    name: 'Same name',
    userId: String(userId),
    lastUpdated,
    firstCreated: lastUpdated,
  }));
  await Session.collection.insertMany(docs);
  return { userId: String(userId), ids: docs.map(d => String(d._id)) };
};

const walk = async (userId: string, field: string, direction: 'asc' | 'desc') => {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const result = await sessionRepository.search(undefined, { userId }, { page, limit: PAGE }, { field, direction });
    ids.push(...result.data.map(s => s.id));
    if (!result.hasMore) return ids;
  }
};

describe('SessionRepository.search offset pages over a shared sort value', () => {
  it.each([
    ['lastUpdated', 'desc'],
    ['lastUpdated', 'asc'],
    ['name', 'asc'],
  ] as const)('ordered by %s %s returns each notebook exactly once', async (field, direction) => {
    const { userId, ids } = await seed();
    const expected = [...ids].sort((a, b) => (direction === 'desc' ? b.localeCompare(a) : a.localeCompare(b)));
    expect(await walk(userId, field, direction)).toEqual(expected);
  });
});
