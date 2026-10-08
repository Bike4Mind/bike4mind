// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest } from '@bike4mind/database';
import { claimPendingAction } from './pendingActionExecutor';

/**
 * Single-use is the property a mocked findOneAndUpdate cannot show: two confirms that both read the
 * action must race on the real atomic update, and exactly one may win.
 */
describe('claimPendingAction', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  }, MONGO_TEST_TIMEOUT_MS);

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

    const claims = await Promise.all([claimPendingAction(questId, 1000), claimPendingAction(questId, 1000)]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await storedPendingAction(questId)).toBeUndefined();
  });

  it('refuses a claim for an action that a newer one has replaced', async () => {
    const questId = await insertQuestWithPendingAction(2000);

    expect(await claimPendingAction(questId, 1999)).toBe(false);
    expect(await storedPendingAction(questId)).toMatchObject({ ts: 2000 });
  });
});
