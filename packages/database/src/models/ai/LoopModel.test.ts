import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Loop, loopRepository } from './LoopModel';

const USER = 'user-1';
const LEASE_MS = 5 * 60 * 1000;

const later = (at: Date) => new Date(at.getTime() + 60_000);

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

  it('loads a loop with no stageConfig and rejects an unknown runner', async () => {
    expect((await create()).stageConfig).toBeUndefined();
    const withConfig = await create({ stageConfig: [{ stage: 'doing', runner: 'desktop', tools: ['web_search'] }] });
    expect(withConfig.stageConfig).toEqual([{ stage: 'doing', runner: 'desktop', tools: ['web_search'] }]);
    await expect(create({ stageConfig: [{ stage: 'doing', runner: 'laptop' }] })).rejects.toThrow(/runner/);
  });

  it('rejects an interval under 5 minutes or a fractional one', async () => {
    await expect(create({ intervalMinutes: 4 })).rejects.toThrow(/intervalMinutes/);
    await expect(create({ intervalMinutes: 5.5 })).rejects.toThrow(/intervalMinutes/);
  });

  it('rejects a budget of 0 or below', async () => {
    await expect(create({ budgetCreditsPerDay: 0 })).rejects.toThrow(/budgetCreditsPerDay/);
    await expect(create({ budgetCreditsPerDay: -1 })).rejects.toThrow(/budgetCreditsPerDay/);
    expect((await create({ budgetCreditsPerDay: 0.5 })).budgetCreditsPerDay).toBe(0.5);
  });

  describe('auto-paused loops', () => {
    const now = new Date('2026-10-30T00:00:00Z');

    it('lists only paused loops with autoResume', async () => {
      const budget = await create({ status: 'paused', autoResume: 'budget', statusReason: 'Daily budget reached' });
      await create({ status: 'paused' });
      await create({ status: 'live' });
      expect((await loopRepository.listAutoPaused()).map(loop => loop.id)).toEqual([budget.id]);
    });

    it('resumeAutoPaused only matches a paused loop with the same autoResume', async () => {
      const loop = await create({ status: 'paused', autoResume: 'budget', statusReason: 'Daily budget reached' });
      const owner = await create({ status: 'paused' });

      expect(await loopRepository.resumeAutoPaused(loop.id, 'credits', now)).toBe(false);
      expect(await loopRepository.resumeAutoPaused(owner.id, 'budget', now)).toBe(false);
      expect(await loopRepository.resumeAutoPaused(loop.id, 'budget', now)).toBe(true);
      expect(await loopRepository.resumeAutoPaused(loop.id, 'budget', now)).toBe(false);

      const resumed = await loopRepository.findById(loop.id);
      expect(resumed).toMatchObject({ status: 'live', nextRunAt: now });
      expect(resumed?.autoResume).toBeUndefined();
      expect(resumed?.statusReason).toBeUndefined();
      expect((await loopRepository.findById(owner.id))?.status).toBe('paused');
    });
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

    expect(await loopRepository.makeDueNow(live.id, now)).toBe(true);
    expect(await loopRepository.makeDueNow(paused.id, now)).toBe(false);
    expect(await loopRepository.makeDueNow(alreadyDue.id, now)).toBe(true);

    expect((await loopRepository.findByIdAndUserId(live.id, USER))?.nextRunAt).toEqual(now);
    expect((await loopRepository.findByIdAndUserId(paused.id, USER))?.nextRunAt).toEqual(later);
    expect((await loopRepository.findByIdAndUserId(alreadyDue.id, USER))?.nextRunAt).toEqual(earlier);
  });

  it('makeDueNow ends an idle back-off even when the loop is already due', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);
    const loop = await create({ status: 'live', nextRunAt: earlier, idleStreak: 3 });
    const unscheduled = await create({ status: 'live', idleStreak: 1 });

    await loopRepository.makeDueNow(loop.id, now);
    await loopRepository.makeDueNow(unscheduled.id, now);

    expect(await loopRepository.findById(loop.id)).toMatchObject({
      nextRunAt: earlier,
      idleStreak: 0,
      idleResetAt: now,
    });
    expect(await loopRepository.findById(unscheduled.id)).toMatchObject({ nextRunAt: now, idleStreak: 0 });
  });

  it('endBackoff only moves a loop backing off, and never pushes its next run later', async () => {
    const now = new Date();
    const far = new Date(now.getTime() + 8 * 3_600_000);
    const soon = new Date(now.getTime() + 15 * 60_000);
    const backingOff = await create({ status: 'live', nextRunAt: far, idleStreak: 3 });
    const dueSooner = await create({ status: 'live', nextRunAt: now, idleStreak: 1 });
    const steady = await create({ status: 'live', nextRunAt: far });
    const paused = await create({ status: 'paused', autoResume: 'budget', nextRunAt: far, idleStreak: 2 });
    for (const loop of [backingOff, dueSooner, steady, paused]) await loopRepository.endBackoff(loop.id, soon);
    expect(await loopRepository.findById(paused.id)).toMatchObject({ idleStreak: 2, nextRunAt: far });
    expect(await loopRepository.findById(backingOff.id)).toMatchObject({ idleStreak: 0, nextRunAt: soon });
    expect(await loopRepository.findById(dueSooner.id)).toMatchObject({ idleStreak: 0, nextRunAt: now });
    expect(await loopRepository.findById(steady.id)).toMatchObject({ idleStreak: 0, nextRunAt: far });
    // Stamped on every live loop, so a run in flight is not folded as idle; never on the paused one.
    expect((await loopRepository.findById(steady.id))?.idleResetAt).toBeInstanceOf(Date);
    expect((await loopRepository.findById(paused.id))?.idleResetAt).toBeUndefined();
  });

  it('claimDue skips the users it is told to', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    await create({ status: 'live', nextRunAt: past });
    const theirs = await create({ status: 'live', nextRunAt: new Date(now.getTime() - 1000), userId: 'user-2' });
    expect((await loopRepository.claimDue(now, 60_000, [], [USER]))?.id).toBe(theirs.id);
    expect(await loopRepository.claimDue(now, 60_000, [], [USER, 'user-2'])).toBeNull();
  });

  it('countInFlight counts loops with a run in flight', async () => {
    await create({ activeExecutionId: 'e1' });
    await create({ activeExecutionId: 'e2' });
    await create();
    expect(await loopRepository.countInFlight()).toBe(2);
  });

  it('deferUntil moves a live loop on and releases the lease; a non-live loop keeps its time', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 3_600_000);
    const lease = new Date(now.getTime() + 60_000);
    const live = await create({ status: 'live', nextRunAt: now, leaseUntil: lease });
    const paused = await create({ status: 'paused', nextRunAt: now, leaseUntil: lease });
    await loopRepository.deferUntil(live.id, later, now);
    await loopRepository.deferUntil(paused.id, later, now);
    const [l, p] = [await loopRepository.findById(live.id), await loopRepository.findById(paused.id)];
    expect(l).toMatchObject({ status: 'live', nextRunAt: later, hold: { kind: 'pacing', until: later, at: now } });
    expect(l?.leaseUntil).toBeUndefined();
    expect(p?.nextRunAt).toEqual(now);
    expect(p?.leaseUntil).toBeUndefined();
    expect(p?.hold).toBeUndefined();
  });

  describe('holds and alarms', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const earlier = new Date('2026-11-04T11:00:00Z');

    it('markDispatched and foldRun clear them', async () => {
      const loop = await create({
        status: 'live',
        hold: { kind: 'pacing', until: now, at: earlier },
        alarm: { kind: 'idle_with_work', reason: 'idle', since: earlier },
      });
      await loopRepository.markDispatched(loop.id, 'exec-1', now);
      const dispatched = await loopRepository.findById(loop.id);
      expect(dispatched?.hold).toBeUndefined();
      expect(dispatched?.alarm).toBeUndefined();

      await loopRepository.setAlarm(loop.id, { kind: 'long_run', reason: 'long', since: now, executionId: 'exec-1' });
      expect(await loopRepository.foldRun(loop.id, 'exec-1', {})).toBe(true);
      expect((await loopRepository.findById(loop.id))?.alarm).toBeUndefined();
    });

    it('setCapacityHolds marks only claimable loops outside skipIds; clearCapacityHolds keeps pacing holds', async () => {
      const due = await create({ status: 'live', nextRunAt: earlier });
      const claimed = await create({ status: 'live', nextRunAt: earlier });
      const running = await create({ status: 'live', nextRunAt: earlier, activeExecutionId: 'exec-1' });
      const future = await create({ status: 'live', nextRunAt: new Date(now.getTime() + 60_000) });
      const paused = await create({ status: 'paused', nextRunAt: earlier });
      const paced = await create({ status: 'live', nextRunAt: now, hold: { kind: 'pacing', until: now, at: earlier } });

      await loopRepository.setCapacityHolds(now, [claimed.id]);
      const held = async (id: string) => (await loopRepository.findById(id))?.hold?.kind;
      expect(await held(due.id)).toBe('capacity');
      expect(await held(paced.id)).toBe('capacity');
      for (const id of [claimed.id, running.id, future.id, paused.id]) expect(await held(id)).toBeUndefined();

      await loopRepository.updateForUser(paced.id, USER, { hold: { kind: 'pacing', until: now, at: earlier } });
      await loopRepository.clearCapacityHolds();
      expect(await held(due.id)).toBeUndefined();
      expect(await held(paced.id)).toBe('pacing');
    });

    it('setAlarm keeps since for the same alarm and resets it for another kind or run', async () => {
      const loop = await create({
        status: 'live',
        alarm: { kind: 'long_run', reason: 'long', since: earlier, executionId: 'a' },
      });
      await loopRepository.setAlarm(loop.id, { kind: 'idle_with_work', reason: 'first', since: earlier });
      await loopRepository.setAlarm(loop.id, { kind: 'idle_with_work', reason: '$second', since: now });
      // toEqual: the old long run's executionId must not survive into the idle alarm.
      expect((await loopRepository.findById(loop.id))?.alarm).toEqual({
        kind: 'idle_with_work',
        reason: '$second',
        since: earlier,
      });

      const running = await create({ status: 'live', activeExecutionId: 'b' });
      await loopRepository.setAlarm(running.id, { kind: 'long_run', reason: 'long', since: now, executionId: 'b' });
      await loopRepository.setAlarm(running.id, {
        kind: 'long_run',
        reason: 'long',
        since: later(now),
        executionId: 'b',
      });
      expect((await loopRepository.findById(running.id))?.alarm?.since).toEqual(now);
    });

    it('setAlarm writes nothing once the alarm no longer applies', async () => {
      const running = await create({ status: 'live', activeExecutionId: 'b' });
      const paused = await create({ status: 'paused' });
      await loopRepository.setAlarm(running.id, { kind: 'idle_with_work', reason: 'idle', since: now });
      await loopRepository.setAlarm(running.id, { kind: 'long_run', reason: 'long', since: now, executionId: 'a' });
      await loopRepository.setAlarm(paused.id, { kind: 'idle_with_work', reason: 'idle', since: now });
      expect((await loopRepository.findById(running.id))?.alarm).toBeUndefined();
      expect((await loopRepository.findById(paused.id))?.alarm).toBeUndefined();
    });

    it('clearAlarm is conditional on kind; listAlarmed filters by kind', async () => {
      const idle = await create({ alarm: { kind: 'idle_with_work', reason: 'idle', since: now } });
      const long = await create({ alarm: { kind: 'long_run', reason: 'long', since: now, executionId: 'e' } });
      await create();
      expect((await loopRepository.listAlarmed()).map(loop => loop.id).sort()).toEqual([idle.id, long.id].sort());
      expect((await loopRepository.listAlarmed(['long_run'])).map(loop => loop.id)).toEqual([long.id]);

      await loopRepository.clearAlarm(idle.id, 'long_run');
      expect((await loopRepository.findById(idle.id))?.alarm?.kind).toBe('idle_with_work');
      await loopRepository.clearAlarm(idle.id, 'idle_with_work');
      expect((await loopRepository.findById(idle.id))?.alarm).toBeUndefined();
    });

    it('listPastDueLive returns live loops with no run, due by the cutoff, oldest first', async () => {
      const older = await create({ status: 'live', nextRunAt: new Date(earlier.getTime() - 60_000) });
      const old = await create({ status: 'live', nextRunAt: earlier });
      await create({ status: 'live', nextRunAt: now });
      await create({ status: 'live', nextRunAt: earlier, activeExecutionId: 'exec-1' });
      await create({ status: 'paused', nextRunAt: earlier });
      await create({ status: 'live', nextRunAt: earlier, hold: { kind: 'capacity', at: now } });
      await create({ status: 'live', nextRunAt: earlier, idleStreak: 2 });
      const zeroStreak = await create({
        status: 'live',
        nextRunAt: new Date(earlier.getTime() - 30_000),
        idleStreak: 0,
      });
      expect((await loopRepository.listPastDueLive(earlier, 10)).map(loop => loop.id)).toEqual([
        older.id,
        zeroStreak.id,
        old.id,
      ]);
    });
  });

  it("pauseAllLiveForUser pauses only that user's live loops", async () => {
    const at = new Date();
    const live = await create({ status: 'live' });
    const owned = await create({ status: 'paused' });
    const theirs = await create({ status: 'live', userId: 'user-2' });
    const running = await create({ status: 'live', activeExecutionId: 'exec-1' });
    const patch = { statusReason: 'r', autoResume: 'budget' as const, nextRunAt: at };
    expect(await loopRepository.pauseAllLiveForUser(USER, patch)).toBe(1);
    expect((await loopRepository.findById(running.id))?.status).toBe('live');
    expect(await loopRepository.findById(live.id)).toMatchObject({ status: 'paused', ...patch });
    expect((await loopRepository.findById(owned.id))?.autoResume).toBeUndefined();
    expect((await loopRepository.findById(theirs.id))?.status).toBe('live');
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
