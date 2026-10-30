import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Loop, loopRepository } from './LoopModel';

const USER = 'user-1';
const LEASE_MS = 5 * 60 * 1000;

const create = async (overrides: Record<string, unknown> = {}) => {
  const doc = await Loop.create({
    userId: USER,
    name: 'Digest',
    goal: 'Summarize the inbox',
    model: 'claude-sonnet-5',
    sessionId: 'session-1',
    intervalMinutes: 15,
    ...overrides,
  });
  return doc.toJSON();
};

describe('LoopRepository', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await Loop.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await Loop.deleteMany({});
  });

  it('applies defaults', async () => {
    const loop = await create();
    expect(loop).toMatchObject({
      status: 'draft',
      stages: ['todo', 'doing', 'done'],
      tools: [],
      memory: { notes: '', nextAction: '' },
      runCount: 0,
      consecutiveFailures: 0,
    });
  });

  it('rejects an interval under 5 minutes or a fractional one', async () => {
    await expect(create({ intervalMinutes: 4 })).rejects.toThrow(/intervalMinutes/);
    await expect(create({ intervalMinutes: 5.5 })).rejects.toThrow(/intervalMinutes/);
  });

  it('declares the scheduler and list indexes', async () => {
    const keys = (await Loop.collection.indexes()).map(index => index.key);
    expect(keys).toEqual(
      expect.arrayContaining([{ status: 1, nextRunAt: 1 }, { activeExecutionId: 1 }, { userId: 1, updatedAt: -1 }])
    );
  });

  describe('claimDue', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const past = new Date(now.getTime() - 1000);

    it('lets exactly one of two parallel claims win', async () => {
      await create({ status: 'live', nextRunAt: past });
      const [a, b] = await Promise.all([
        loopRepository.claimDue(now, LEASE_MS),
        loopRepository.claimDue(now, LEASE_MS),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it('skips loops that are not live, not due, leased or have a run in flight', async () => {
      await create({ status: 'paused', nextRunAt: past });
      await create({ status: 'live', nextRunAt: new Date(now.getTime() + 1000) });
      await create({ status: 'live', nextRunAt: past, leaseUntil: new Date(now.getTime() + 1000) });
      await create({ status: 'live', nextRunAt: past, activeExecutionId: 'exec-1' });
      expect(await loopRepository.claimDue(now, LEASE_MS)).toBeNull();
    });

    it('skips the ids it is told to', async () => {
      const loop = await create({ status: 'live', nextRunAt: past });
      expect(await loopRepository.claimDue(now, LEASE_MS, [loop.id])).toBeNull();
    });

    it('reclaims a loop whose lease has expired', async () => {
      await create({ status: 'live', nextRunAt: past, leaseUntil: past });
      expect(await loopRepository.claimDue(now, LEASE_MS)).not.toBeNull();
    });
  });

  it('folds a run once and clears activeExecutionId', async () => {
    const loop = await create({ status: 'live', activeExecutionId: 'exec-1' });
    const update = { $inc: { runCount: 1 } };

    expect(await loopRepository.foldRun(loop.id, 'exec-1', update)).toBe(true);
    expect(await loopRepository.foldRun(loop.id, 'exec-1', update)).toBe(false);

    const after = await loopRepository.findByIdAndUserId(loop.id, USER);
    expect(after?.runCount).toBe(1);
    expect(after?.activeExecutionId).toBeUndefined();
  });

  it('updateForUser unsets nulls and honours expectedStatus', async () => {
    const loop = await create({ agentId: 'agent-1', budgetCreditsPerDay: 10 });
    const cleared = await loopRepository.updateForUser(loop.id, USER, { agentId: null, budgetCreditsPerDay: null });
    expect(cleared?.agentId).toBeUndefined();
    expect(cleared?.budgetCreditsPerDay).toBeUndefined();

    expect(await loopRepository.updateForUser(loop.id, USER, { name: 'x' }, 'live')).toBeNull();
    expect((await loopRepository.updateForUser(loop.id, USER, { name: 'x' }, 'draft'))?.name).toBe('x');
  });

  it('markErroredIfFailing only moves a live loop at the limit', async () => {
    const atLimit = await create({ status: 'live', consecutiveFailures: 3 });
    const below = await create({ status: 'live', consecutiveFailures: 2 });
    const paused = await create({ status: 'paused', consecutiveFailures: 3 });
    for (const loop of [atLimit, below, paused]) await loopRepository.markErroredIfFailing(loop.id, 3);

    expect((await loopRepository.findByIdAndUserId(atLimit.id, USER))?.status).toBe('error');
    expect((await loopRepository.findByIdAndUserId(below.id, USER))?.status).toBe('live');
    expect((await loopRepository.findByIdAndUserId(paused.id, USER))?.status).toBe('paused');
  });

  it('scopes reads, updates and deletes to the owner', async () => {
    const loop = await create();
    expect(await loopRepository.findByIdAndUserId(loop.id, 'user-2')).toBeNull();
    expect(await loopRepository.updateForUser(loop.id, 'user-2', { name: 'x' })).toBeNull();
    expect(await loopRepository.deleteForUser(loop.id, 'user-2')).toBe(false);
    expect(await loopRepository.deleteForUser(loop.id, USER)).toBe(true);
  });

  it('makeDueNow pulls a live loop forward and leaves others alone', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    const live = await create({ status: 'live', nextRunAt: later });
    const paused = await create({ status: 'paused', nextRunAt: later });
    const earlier = new Date(now.getTime() - 60_000);
    const alreadyDue = await create({ status: 'live', nextRunAt: earlier });

    for (const loop of [live, paused, alreadyDue]) await loopRepository.makeDueNow(loop.id, now);

    expect((await loopRepository.findByIdAndUserId(live.id, USER))?.nextRunAt).toEqual(now);
    expect((await loopRepository.findByIdAndUserId(paused.id, USER))?.nextRunAt).toEqual(later);
    expect((await loopRepository.findByIdAndUserId(alreadyDue.id, USER))?.nextRunAt).toEqual(earlier);
  });

  it("removeFromOversees pulls a deleted loop from the owner's other loops only", async () => {
    const a = await create({ oversees: ['gone', 'kept'] });
    const b = await create({ oversees: ['gone'] });
    const foreign = await create({ userId: 'user-2', oversees: ['gone'] });
    await loopRepository.removeFromOversees(USER, 'gone');
    expect((await loopRepository.findById(a.id))?.oversees).toEqual(['kept']);
    expect((await loopRepository.findById(b.id))?.oversees).toEqual([]);
    expect((await loopRepository.findById(foreign.id))?.oversees).toEqual(['gone']);
  });

  it('updateForUser with oversees null unsets it', async () => {
    const loop = await create({ oversees: ['x'] });
    const updated = await loopRepository.updateForUser(loop.id, USER, { oversees: null });
    expect(updated?.oversees).toBeUndefined();
  });
});
