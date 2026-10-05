import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Quest.deleteMany({});
});

const SESSION = 'session-1';
const CALLBACK = { url: 'https://example.com/webhooks/quest-settled', apiKeyId: 'api-key-1' };

function seed(over: Record<string, unknown> = {}) {
  return { sessionId: SESSION, type: 'chat', timestamp: new Date('2026-01-01T00:00:00Z'), ...over };
}

async function backdate(id: string, agoMs: number) {
  // Raw collection write: bypasses the timestamps plugin entirely, which would
  // otherwise overwrite an explicit `updatedAt` set through a Mongoose query.
  await Quest.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(id) },
    { $set: { updatedAt: new Date(Date.now() - agoMs) } }
  );
}

describe('questRepository.claimCallbackDispatch', () => {
  it('returns false while the quest is still running, even with a pending callback', async () => {
    const quest = await Quest.create(seed({ status: 'running' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);

    await expect(questRepository.claimCallbackDispatch(id)).resolves.toBeNull();
  });

  it('returns false while the status field is absent entirely', async () => {
    const quest = await Quest.create(seed());
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);

    await expect(questRepository.claimCallbackDispatch(id)).resolves.toBeNull();
  });

  it('returns true once status is done and callback.state is pending; a second claim returns false', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);

    await expect(questRepository.claimCallbackDispatch(id)).resolves.toMatch(/^quest_/);
    await expect(questRepository.claimCallbackDispatch(id)).resolves.toBeNull();
  });

  it('also claims a stopped quest (the other terminal status)', async () => {
    const quest = await Quest.create(seed({ status: 'stopped' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);

    await expect(questRepository.claimCallbackDispatch(id)).resolves.toMatch(/^quest_/);
  });

  it('under 5 concurrent claims on one done quest, exactly one succeeds', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);

    const results = await Promise.all(Array.from({ length: 5 }, () => questRepository.claimCallbackDispatch(id)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(r => !r)).toHaveLength(4);
  });
});

describe('questRepository.armCallback', () => {
  it('mints a fresh event id per arm, so a re-armed (retried) quest is a new event for the receiver', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();

    await questRepository.armCallback(id, CALLBACK);
    const first = await questRepository.findCallbackById(id);
    await questRepository.armCallback(id, CALLBACK);
    const second = await questRepository.findCallbackById(id);

    expect(first?.eventId).toMatch(new RegExp(`^quest_${id}_[0-9a-f]{16}$`));
    expect(second?.eventId).toMatch(new RegExp(`^quest_${id}_[0-9a-f]{16}$`));
    expect(second?.eventId).not.toBe(first?.eventId);
    expect(second?.state).toBe('pending');
  });
});

// Mirrors the generation services' retry branch (ImageGeneration/VideoGeneration/ImageEdit invoke):
// read the finished quest, clear its status, then the route arms a callback and dispatches at once.
describe('re-arming a retried quest', () => {
  async function retryThenArm(updateOptions?: Record<string, unknown>) {
    const created = await Quest.create(seed({ status: 'done' }));
    const quest = await questRepository.findById(created._id.toString());
    if (!quest) throw new Error('seeded quest not found');
    quest.status = undefined;
    await questRepository.update(quest, updateOptions);
    await questRepository.armCallback(quest.id, CALLBACK);
    return questRepository.claimCallbackDispatch(quest.id);
  }

  it('does not claim against the previous run once status is unset', async () => {
    await expect(retryThenArm({ unset: ['status'] })).resolves.toBeNull();
  });

  it('would claim against the previous run if status were only set to undefined', async () => {
    // Pins why the services pass `unset`: an undefined in $set is dropped and the old status survives.
    await expect(retryThenArm()).resolves.toMatch(/^quest_/);
  });
});

describe('callback is select: false', () => {
  it('a plain findById never carries callback; findCallbackById does', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);

    const found = await questRepository.findById(id);
    expect(found).not.toBeNull();
    expect('callback' in (found as object)).toBe(false);
    expect(found?.callback).toBeUndefined();

    const callback = await questRepository.findCallbackById(id);
    expect(callback).toEqual({
      url: CALLBACK.url,
      apiKeyId: CALLBACK.apiKeyId,
      eventId: expect.stringMatching(/^quest_/),
      state: 'pending',
    });
  });
});

describe('a whole-document update() cannot rewind the select:false callback from stale state', () => {
  it('a benign field edit through a stale findById-read leaves callback.state at dispatched', async () => {
    const quest = await Quest.create(seed({ status: 'done', reply: 'original reply' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);
    await questRepository.claimCallbackDispatch(id);

    const readDoc = await questRepository.findById(id);
    expect(readDoc).not.toBeNull();
    expect('callback' in (readDoc as object)).toBe(false);

    await questRepository.update({ ...(readDoc as NonNullable<typeof readDoc>), reply: 'edited reply' });

    const afterUpdate = await questRepository.findById(id);
    expect(afterUpdate?.reply).toBe('edited reply');

    const callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('dispatched');
  });
});

describe('questRepository.releaseCallbackDispatch', () => {
  it('puts a dispatched callback back to pending, unsets dispatchedAt, and allows re-claim while terminal', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);
    const eventId = await questRepository.claimCallbackDispatch(id);
    if (!eventId) throw new Error('claim failed');

    let callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('dispatched');
    expect(callback?.dispatchedAt).toBeInstanceOf(Date);
    expect(callback?.eventId).toBe(eventId);

    await questRepository.releaseCallbackDispatch(id, eventId);

    callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('pending');
    expect(callback?.dispatchedAt).toBeUndefined();

    await expect(questRepository.claimCallbackDispatch(id)).resolves.toMatch(/^quest_/);
  });

  it('is a no-op against a callback that is still pending (nothing to release)', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);
    const armed = await questRepository.findCallbackById(id);
    if (!armed) throw new Error('arm failed');

    await questRepository.releaseCallbackDispatch(id, armed.eventId);

    const callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('pending');
  });

  it('does not rewind a newer claim made after a re-arm (a slow, stale enqueue failure)', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);
    const staleEventId = await questRepository.claimCallbackDispatch(id);
    if (!staleEventId) throw new Error('first claim failed');
    await questRepository.armCallback(id, CALLBACK);
    const freshEventId = await questRepository.claimCallbackDispatch(id);
    expect(freshEventId).not.toBe(staleEventId);

    await questRepository.releaseCallbackDispatch(id, staleEventId);

    const callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('dispatched');
    expect(callback?.eventId).toBe(freshEventId);
  });
});

describe('questRepository.recordCallbackAttempt', () => {
  async function dispatchedQuestId() {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);
    const eventId = await questRepository.claimCallbackDispatch(id);
    if (!eventId) throw new Error('claim failed');
    return { id, eventId };
  }

  it('allows a delivered replay from a failed state', async () => {
    const { id, eventId } = await dispatchedQuestId();
    await questRepository.recordCallbackAttempt(id, eventId, {
      state: 'failed',
      statusCode: 500,
      error: 'connection reset',
    });

    let callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('failed');

    await questRepository.recordCallbackAttempt(id, eventId, { state: 'delivered', statusCode: 200 });

    callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('delivered');
    expect(callback?.lastStatusCode).toBe(200);
    expect(callback?.completedAt).toBeInstanceOf(Date);
    expect(callback?.lastError).toBeUndefined();
  });

  it('does nothing while the callback is still pending (no dispatched/failed to match)', async () => {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);
    const armed = await questRepository.findCallbackById(id);
    if (!armed) throw new Error('arm failed');

    await expect(
      questRepository.recordCallbackAttempt(id, armed.eventId, { state: 'delivered' })
    ).resolves.not.toThrow();

    const callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('pending');
  });

  it('truncates a lastError longer than 500 chars to exactly 500', async () => {
    const { id, eventId } = await dispatchedQuestId();
    const longError = 'x'.repeat(600);

    await questRepository.recordCallbackAttempt(id, eventId, { state: 'failed', error: longError });

    const callback = await questRepository.findCallbackById(id);
    expect(callback?.lastError).toHaveLength(500);
    expect(callback?.lastError).toBe('x'.repeat(500));
  });

  it('does not set completedAt for a dispatched-state attempt (retry diagnostics only)', async () => {
    const { id, eventId } = await dispatchedQuestId();
    await questRepository.recordCallbackAttempt(id, eventId, { state: 'dispatched', statusCode: 503 });

    const callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('dispatched');
    expect(callback?.lastStatusCode).toBe(503);
    expect(callback?.completedAt).toBeUndefined();
  });

  it('is a no-op against a stale eventId (state unchanged after a re-arm)', async () => {
    const { id, eventId: staleEventId } = await dispatchedQuestId();
    await questRepository.releaseCallbackDispatch(id, staleEventId);
    await questRepository.armCallback(id, CALLBACK);
    const freshEventId = await questRepository.claimCallbackDispatch(id);
    if (!freshEventId) throw new Error('re-claim failed');

    await expect(
      questRepository.recordCallbackAttempt(id, staleEventId, { state: 'delivered', statusCode: 200 })
    ).resolves.not.toThrow();

    const callback = await questRepository.findCallbackById(id);
    expect(callback?.state).toBe('dispatched');
    expect(callback?.eventId).toBe(freshEventId);
  });
});

describe('questRepository.findUndispatchedCallbacks', () => {
  it('excludes a running quest, excludes a dispatched callback, and excludes one updated after settledBefore', async () => {
    const running = await Quest.create(seed({ status: 'running' }));
    await questRepository.armCallback(running._id.toString(), CALLBACK);
    await backdate(running._id.toString(), 300_000);

    const alreadyDispatched = await Quest.create(seed({ status: 'done' }));
    await questRepository.armCallback(alreadyDispatched._id.toString(), CALLBACK);
    await questRepository.claimCallbackDispatch(alreadyDispatched._id.toString());
    await backdate(alreadyDispatched._id.toString(), 300_000);

    const tooRecent = await Quest.create(seed({ status: 'done' }));
    await questRepository.armCallback(tooRecent._id.toString(), CALLBACK);
    // Deliberately not backdated: updatedAt stays "now", after settledBefore.

    const eligible = await Quest.create(seed({ status: 'done' }));
    await questRepository.armCallback(eligible._id.toString(), CALLBACK);
    await backdate(eligible._id.toString(), 300_000);

    const ids = await questRepository.findUndispatchedCallbacks({
      settledBefore: new Date(Date.now() - 120_000),
      limit: 10,
    });

    expect(ids).toEqual([eligible._id.toString()]);
  });

  it('sorts oldest-updatedAt-first and respects the limit', async () => {
    const older = await Quest.create(seed({ status: 'done' }));
    await questRepository.armCallback(older._id.toString(), CALLBACK);
    await backdate(older._id.toString(), 600_000);

    const middle = await Quest.create(seed({ status: 'done' }));
    await questRepository.armCallback(middle._id.toString(), CALLBACK);
    await backdate(middle._id.toString(), 300_000);

    const newest = await Quest.create(seed({ status: 'done' }));
    await questRepository.armCallback(newest._id.toString(), CALLBACK);
    await backdate(newest._id.toString(), 200_000);

    const settledBefore = new Date(Date.now() - 100_000);

    const all = await questRepository.findUndispatchedCallbacks({ settledBefore, limit: 10 });
    expect(all).toEqual([older._id.toString(), middle._id.toString(), newest._id.toString()]);

    const limited = await questRepository.findUndispatchedCallbacks({ settledBefore, limit: 2 });
    expect(limited).toEqual([older._id.toString(), middle._id.toString()]);
  });
});

describe('stale dispatched callbacks', () => {
  const WINDOW_MS = 6 * 60 * 60 * 1000;
  const HORIZON_MS = 72 * 60 * 60 * 1000;
  const criteria = () => ({
    dispatchedBefore: new Date(Date.now() - WINDOW_MS),
    dispatchedAfter: new Date(Date.now() - HORIZON_MS),
    maxRedispatches: 3,
  });

  async function dispatchedQuest(dispatchedAgoMs: number, redispatchCount?: number) {
    const quest = await Quest.create(seed({ status: 'done' }));
    const id = quest._id.toString();
    await questRepository.armCallback(id, CALLBACK);
    await questRepository.claimCallbackDispatch(id);
    // Raw write, as backdate() above: the claim stamps dispatchedAt with "now".
    await Quest.collection.updateOne(
      { _id: quest._id },
      {
        $set: {
          'callback.dispatchedAt': new Date(Date.now() - dispatchedAgoMs),
          ...(redispatchCount !== undefined && { 'callback.redispatchCount': redispatchCount }),
        },
      }
    );
    return id;
  }

  describe('questRepository.findStaleDispatchedCallbacks', () => {
    it('matches only dispatched claims between the window and the horizon with reclaims left', async () => {
      const stale = await dispatchedQuest(WINDOW_MS + 60_000);
      const reclaimedOnce = await dispatchedQuest(WINDOW_MS + 60_000, 2);
      await dispatchedQuest(WINDOW_MS - 60_000); // still inside the delivery window
      await dispatchedQuest(WINDOW_MS + 60_000, 3); // reclaims used up
      await dispatchedQuest(HORIZON_MS + 60_000); // past the re-send horizon

      const pending = await Quest.create(seed({ status: 'done' }));
      await questRepository.armCallback(pending._id.toString(), CALLBACK);

      const delivered = await dispatchedQuest(WINDOW_MS + 60_000);
      const eventId = (await questRepository.findCallbackById(delivered))!.eventId;
      await questRepository.recordCallbackAttempt(delivered, eventId, { state: 'delivered', statusCode: 200 });

      const ids = await questRepository.findStaleDispatchedCallbacks({ ...criteria(), limit: 10 });

      expect(ids.sort()).toEqual([stale, reclaimedOnce].sort());
    });

    it('sorts oldest claim first and respects the limit', async () => {
      const newest = await dispatchedQuest(WINDOW_MS + 60_000);
      const oldest = await dispatchedQuest(WINDOW_MS + 180_000);
      const middle = await dispatchedQuest(WINDOW_MS + 120_000);

      await expect(questRepository.findStaleDispatchedCallbacks({ ...criteria(), limit: 10 })).resolves.toEqual([
        oldest,
        middle,
        newest,
      ]);
      await expect(questRepository.findStaleDispatchedCallbacks({ ...criteria(), limit: 2 })).resolves.toEqual([
        oldest,
        middle,
      ]);
    });
  });

  describe('questRepository.reclaimStaleCallbackDispatch', () => {
    it('returns the original event id, moves dispatchedAt to now and counts the reclaim', async () => {
      const id = await dispatchedQuest(WINDOW_MS + 60_000);
      const before = await questRepository.findCallbackById(id);

      const eventId = await questRepository.reclaimStaleCallbackDispatch(id, criteria());

      expect(eventId).toBe(before!.eventId);
      const after = await questRepository.findCallbackById(id);
      expect(after!.state).toBe('dispatched');
      expect(after!.redispatchCount).toBe(1);
      expect(Date.now() - after!.dispatchedAt!.getTime()).toBeLessThan(60_000);
    });

    it('does not touch a claim still inside the delivery window', async () => {
      const id = await dispatchedQuest(WINDOW_MS - 60_000);
      const before = await questRepository.findCallbackById(id);

      await expect(questRepository.reclaimStaleCallbackDispatch(id, criteria())).resolves.toBeNull();

      const after = await questRepository.findCallbackById(id);
      expect(after!.dispatchedAt).toEqual(before!.dispatchedAt);
      expect(after!.redispatchCount).toBeUndefined();
    });

    it('does not touch a claim past the re-send horizon', async () => {
      const id = await dispatchedQuest(HORIZON_MS + 60_000);

      await expect(questRepository.reclaimStaleCallbackDispatch(id, criteria())).resolves.toBeNull();
      expect((await questRepository.findCallbackById(id))!.redispatchCount).toBeUndefined();
    });

    it('stops once the reclaims are used up', async () => {
      const id = await dispatchedQuest(WINDOW_MS + 60_000, 3);

      await expect(questRepository.reclaimStaleCallbackDispatch(id, criteria())).resolves.toBeNull();
    });

    it('under 5 concurrent reclaims of one stale callback, exactly one succeeds', async () => {
      const id = await dispatchedQuest(WINDOW_MS + 60_000);
      const shared = criteria();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => questRepository.reclaimStaleCallbackDispatch(id, shared))
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await questRepository.findCallbackById(id))!.redispatchCount).toBe(1);
    });
  });
});
