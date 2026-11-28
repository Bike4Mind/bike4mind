import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { Session, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import defineAbilitiesFor from '../auth/ability';
import { getSessionsByUser, getVisibleSessions } from './sessionCrud';

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

afterEach(async () => {
  await Session.collection.deleteMany({});
});

const COUNT = 7;
const PAGE = 3;

/** Every notebook shares one lastUpdated, so only the _id tiebreak orders them. */
const seed = async () => {
  const user = new User({ _id: new mongoose.Types.ObjectId(), username: 'paging-user', email: 'paging@example.com' });
  const lastUpdated = new Date(Date.UTC(2026, 0, 1));
  const docs = Array.from({ length: COUNT }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    name: `nb-${i}`,
    userId: user.id,
    lastUpdated,
    firstCreated: lastUpdated,
  }));
  await Session.collection.insertMany(docs);
  return { user, expected: docs.map(d => String(d._id)).sort((a, b) => b.localeCompare(a)) };
};

const walk = async (fetchPage: (page: number) => Promise<{ data: Array<{ id: string }>; hasMore: boolean }>) => {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const result = await fetchPage(page);
    ids.push(...result.data.map(s => s.id));
    if (!result.hasMore) return ids;
  }
};

describe('sessionCrud offset pages over a shared lastUpdated', () => {
  it('getSessionsByUser returns each notebook exactly once, ordered by _id', async () => {
    const { user, expected } = await seed();
    const ids = await walk(page => getSessionsByUser(user, undefined, { pagination: { page, limit: PAGE } }));
    expect(ids).toEqual(expected);
  });

  it('getVisibleSessions returns each notebook exactly once, ordered by _id', async () => {
    const { user, expected } = await seed();
    const ability = defineAbilitiesFor(user);
    const ids = await walk(page => getVisibleSessions(ability, undefined, { pagination: { page, limit: PAGE } }));
    expect(ids).toEqual(expected);
  });
});
