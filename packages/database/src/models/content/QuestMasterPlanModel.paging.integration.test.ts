import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { QuestMasterPlan, questMasterPlanRepository as repo } from './QuestMasterPlanModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await QuestMasterPlan.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await QuestMasterPlan.collection.deleteMany({});
});

const OWNER = 'owner-1';
const COUNT = 7;
const PAGE = 3;

/** Every plan shares one lastAccessedAt, so only the _id tiebreak orders them. */
const seed = async () => {
  const lastAccessedAt = new Date(Date.UTC(2026, 0, 1));
  const docs = Array.from({ length: COUNT }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    notebookId: `nb-${i}`,
    userId: OWNER,
    goal: `goal-${i}`,
    state: 'active',
    deletedAt: null,
    lastAccessedAt,
  }));
  await QuestMasterPlan.collection.insertMany(docs);
  return docs.map(d => String(d._id)).sort((a, b) => b.localeCompare(a));
};

const walk = async (fetchPage: (offset: number) => Promise<Array<{ _id: unknown }>>) => {
  const ids: string[] = [];
  for (let offset = 0; offset < COUNT + PAGE; offset += PAGE) {
    ids.push(...(await fetchPage(offset)).map(p => String(p._id)));
  }
  return ids;
};

describe('QuestMasterPlanRepository offset pages over a shared lastAccessedAt', () => {
  it('findByUserId returns each plan exactly once, ordered by _id', async () => {
    const expected = await seed();
    const ids = await walk(offset => repo.findByUserId(OWNER, { limit: PAGE, offset }));
    expect(ids).toEqual(expected);
  });

  it('findByUserIdWithCount returns each plan exactly once, ordered by _id', async () => {
    const expected = await seed();
    const ids = await walk(async offset => (await repo.findByUserIdWithCount(OWNER, { limit: PAGE, offset })).plans);
    expect(ids).toEqual(expected);
  });

  it('findAccessibleByUserId returns each plan exactly once, ordered by _id', async () => {
    const expected = await seed();
    const ids = await walk(offset => repo.findAccessibleByUserId(OWNER, { limit: PAGE, offset }));
    expect(ids).toEqual(expected);
  });
});
