import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Quest.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Quest.collection.deleteMany({});
});

const CUTOFF = 1_700_000_000_000;
const insert = (sessionId: string, fields: Record<string, unknown> = {}) =>
  Quest.collection.insertOne({ sessionId, timestamp: new Date(), deletedAt: null, ...fields });
const pending = (ts: number) => ({ pendingAction: { tool: 't', params: {}, ts } });

describe('questRepository.findPendingActionsBySessionIds', () => {
  it('lists the newest approvals of the given sessions raised after the cutoff, up to the limit', async () => {
    await insert('s1', pending(CUTOFF));
    const older = await insert('s1', pending(CUTOFF + 1));
    const newer = await insert('s2', pending(CUTOFF + 2));
    await insert('s1', pending(CUTOFF + 3));
    await insert('theirs', pending(CUTOFF + 9));

    const found = await questRepository.findPendingActionsBySessionIds(['s1', 's2'], CUTOFF, 2);

    expect(found.map(action => action.ts)).toEqual([CUTOFF + 3, CUTOFF + 2]);
    expect(found[1]).toEqual({
      questId: newer.insertedId.toString(),
      sessionId: 's2',
      tool: 't',
      ts: CUTOFF + 2,
      params: {},
    });
    expect(found.map(action => action.questId)).not.toContain(older.insertedId.toString());
    await expect(questRepository.findPendingActionsBySessionIds([], CUTOFF, 2)).resolves.toEqual([]);
  });
});

describe('questRepository.countPendingActionsBySessionIds', () => {
  it('counts the open approvals of the given sessions only, from the cutoff on', async () => {
    await insert('s1', pending(CUTOFF));
    await insert('s1', pending(CUTOFF + 1));
    await insert('s2', pending(CUTOFF + 50));
    await insert('s1', pending(CUTOFF - 1));
    await insert('s1');
    await insert('theirs', pending(CUTOFF + 5));
    await insert('s1', { ...pending(CUTOFF + 9), deletedAt: new Date() });

    await expect(questRepository.countPendingActionsBySessionIds(['s1', 's2'], CUTOFF)).resolves.toBe(3);
  });

  it('is zero without a session, without a query', async () => {
    await insert('s1', pending(CUTOFF + 1));
    const count = vi.spyOn(Quest, 'countDocuments');

    await expect(questRepository.countPendingActionsBySessionIds([], CUTOFF)).resolves.toBe(0);
    expect(count).not.toHaveBeenCalled();
  });

  it('is served by the partial sessionId_pendingActionTs index, which holds only quests with a pending action', async () => {
    const index = (await Quest.collection.indexes()).find(i => i.name === 'sessionId_pendingActionTs');
    expect(index?.key).toEqual({ sessionId: 1, 'pendingAction.ts': -1 });
    expect(index?.partialFilterExpression).toEqual({ 'pendingAction.ts': { $exists: true } });

    for (let i = 0; i < 20; i++) await insert('s1');
    const plan = await Quest.find({ sessionId: { $in: ['s1', 's2'] }, 'pendingAction.ts': { $gte: CUTOFF } }).explain(
      'queryPlanner'
    );
    expect(JSON.stringify(plan)).toContain('"indexName":"sessionId_pendingActionTs"');
  });
});
