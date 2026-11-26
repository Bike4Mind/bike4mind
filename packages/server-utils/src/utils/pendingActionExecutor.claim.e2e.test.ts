// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest, Session } from '@bike4mind/database';
import { cancelPendingActionOnQuest, claimPendingAction } from './pendingActionExecutor';

const push = vi.hoisted(() => ({ configured: true, publish: vi.fn() }));
vi.mock('./pushNotifications', () => ({
  isPushDeliveryConfigured: () => push.configured,
  publishApprovalResolvedPush: push.publish,
}));

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

  describe('clearing push', () => {
    beforeEach(() => {
      push.configured = true;
      push.publish.mockReset();
    });

    const insertQuest = async (fields: Record<string, unknown>) => {
      const _id = new mongoose.Types.ObjectId();
      await Quest.collection.insertOne({
        _id,
        pendingAction: { tool: 'create_issue', params: {}, ts: 5000 },
        ...fields,
      });
      return _id.toString();
    };

    it("publishes to the turn's requester with the outcome once the claim wins", async () => {
      const questId = await insertQuest({ sessionId: 'session-1', promptMeta: { session: { userId: 'requester-1' } } });

      expect(await claimPendingAction(questId, 5000, 'denied')).toBe(true);

      expect(push.publish).toHaveBeenCalledWith(
        { userId: 'requester-1', sessionId: 'session-1', questId, pendingActionTs: 5000 },
        'denied',
        expect.anything()
      );
    });

    it('falls back to the session owner when the quest has no promptMeta', async () => {
      const session = await Session.collection.insertOne({ userId: 'owner-1' });
      const sessionId = session.insertedId.toString();
      const questId = await insertQuest({ sessionId });

      await claimPendingAction(questId, 5000, 'lapsed');

      expect(push.publish).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'owner-1', sessionId }),
        'lapsed',
        expect.anything()
      );
    });

    it('publishes nothing for a claim that lost the race', async () => {
      const questId = await insertQuest({ sessionId: 'session-1', promptMeta: { session: { userId: 'u' } } });

      await claimPendingAction(questId, 5000, 'approved');
      push.publish.mockClear();
      expect(await claimPendingAction(questId, 5000, 'denied')).toBe(false);

      expect(push.publish).not.toHaveBeenCalled();
    });

    it('publishes nothing while push delivery is unconfigured', async () => {
      push.configured = false;
      const questId = await insertQuest({ sessionId: 'session-1', promptMeta: { session: { userId: 'u' } } });

      expect(await claimPendingAction(questId, 5000, 'approved')).toBe(true);
      expect(push.publish).not.toHaveBeenCalled();
    });

    it('still reports the claim as won when the publish fails', async () => {
      push.publish.mockRejectedValue(new Error('eventbridge down'));
      const questId = await insertQuest({ sessionId: 'session-1', promptMeta: { session: { userId: 'u' } } });

      expect(await claimPendingAction(questId, 5000, 'approved')).toBe(true);
    });
  });
});
