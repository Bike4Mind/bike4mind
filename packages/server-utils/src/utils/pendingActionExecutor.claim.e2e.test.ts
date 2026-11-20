// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest } from '@bike4mind/database';
import { cancelPendingActionOnQuest, claimPendingAction } from './pendingActionExecutor';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Single-use is the property a mocked findOneAndUpdate cannot show: two confirms that both read the
 * action must race on the real atomic update, and exactly one may win.
 */
describe('claimPendingAction', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  // Inserted raw: the claim only touches pendingAction, so the rest of a Quest's required shape is noise.
  const insertQuestWithPendingAction = async (ts: number) => {
    const _id = new mongoose.Types.ObjectId();
    await Quest.collection.insertOne({ _id, pendingAction: { tool: 'create_issue', params: { title: 't' }, ts } });
    return _id.toString();
  };

  const storedPendingAction = async (questId: string) =>
    (await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(questId) }))?.pendingAction;

  it('lets exactly one of two concurrent claims win and consumes the action', async () => {
    const questId = await insertQuestWithPendingAction(1000);

    const claims = await Promise.all([
      claimPendingAction(questId, 1000, 'approved'),
      claimPendingAction(questId, 1000, 'denied'),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await storedPendingAction(questId)).toBeUndefined();
    const stored = await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(questId) });
    expect(stored?.pendingActionResolution).toMatchObject({
      ts: 1000,
      outcome: claims[0] ? 'approved' : 'denied',
      at: expect.any(Date),
    });
  });

  it('refuses a claim for an action that a newer one has replaced', async () => {
    const questId = await insertQuestWithPendingAction(2000);

    expect(await claimPendingAction(questId, 1999, 'approved')).toBe(false);
    expect(await storedPendingAction(questId)).toMatchObject({ ts: 2000 });
    expect(
      (await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(questId) }))?.pendingActionResolution
    ).toBeUndefined();
  });

  it('records a cancel without an expected ts as a denial of whatever is pending', async () => {
    const questId = await insertQuestWithPendingAction(3000);
    const logger = { info: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof cancelPendingActionOnQuest>[1];

    expect(await cancelPendingActionOnQuest(questId, logger)).toMatchObject({ success: true });
    expect(await storedPendingAction(questId)).toBeUndefined();
    expect(
      (await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(questId) }))?.pendingActionResolution
    ).toMatchObject({ ts: 3000, outcome: 'denied' });
  });
});
