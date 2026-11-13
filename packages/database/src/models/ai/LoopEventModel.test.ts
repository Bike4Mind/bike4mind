import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { LoopEvent, loopEventRepository } from './LoopEventModel';

const USER = 'user-1';
const LOOP = 'loop-1';

const fields = (overrides: Record<string, unknown> = {}) => ({
  loopId: LOOP,
  userId: USER,
  executionId: 'exec-1',
  workItemId: 'ticket-1',
  ticketTitle: 'Research X',
  iteration: 2,
  confidence: 0.3,
  reason: 'Low confidence',
  requestedAt: new Date(1000),
  ...overrides,
});

describe('LoopEventRepository', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await LoopEvent.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await LoopEvent.deleteMany({});
  });

  it('recordUnsure writes one event per gate', async () => {
    await loopEventRepository.recordUnsure(fields());
    await loopEventRepository.recordUnsure(fields({ reason: 'changed' }));
    await loopEventRepository.recordUnsure(fields({ requestedAt: new Date(2000) }));

    const events = await loopEventRepository.listForLoop(USER, LOOP, 10);
    expect(events).toHaveLength(2);
    expect(events.every(event => event.kind === 'unsure')).toBe(true);
    expect(events.map(event => event.reason)).toEqual(['Low confidence', 'Low confidence']);
  });

  it('resolveUnsure creates the event when the scheduler has not yet, and the first resolution wins', async () => {
    await loopEventRepository.resolveUnsure(fields(), { outcome: 'resumed', by: USER, at: new Date(3000) });
    await loopEventRepository.recordUnsure(fields());
    await loopEventRepository.resolveUnsure(fields(), { outcome: 'rejected', at: new Date(4000) });

    const events = await loopEventRepository.listForLoop(USER, LOOP, 10);
    expect(events).toHaveLength(1);
    expect(events[0].resolution).toMatchObject({ outcome: 'resumed', by: USER });
  });

  it('listResumedUnfolded returns resumed events until they are folded', async () => {
    await loopEventRepository.resolveUnsure(fields(), { outcome: 'resumed', at: new Date() });
    await loopEventRepository.resolveUnsure(fields({ executionId: 'exec-2' }), { outcome: 'rejected', at: new Date() });
    await loopEventRepository.recordUnsure(fields({ executionId: 'exec-3' }));

    const [resumed, ...rest] = await loopEventRepository.listResumedUnfolded(10);
    expect(rest).toEqual([]);
    expect(resumed.executionId).toBe('exec-1');

    await loopEventRepository.markFolded(resumed.id, new Date());
    expect(await loopEventRepository.listResumedUnfolded(10)).toEqual([]);
  });

  it('hasUnfolded is true only for a resumed, unfolded event of that run', async () => {
    expect(await loopEventRepository.hasUnfolded('exec-1')).toBe(false);
    await loopEventRepository.resolveUnsure(fields(), { outcome: 'rejected', at: new Date() });
    expect(await loopEventRepository.hasUnfolded('exec-1')).toBe(false);
    await LoopEvent.deleteMany({});
    await loopEventRepository.resolveUnsure(fields(), { outcome: 'resumed', at: new Date() });
    expect(await loopEventRepository.hasUnfolded('exec-1')).toBe(true);
    expect(await loopEventRepository.hasUnfolded('exec-2')).toBe(false);
    const [event] = await loopEventRepository.listResumedUnfolded(1);
    await loopEventRepository.markFolded(event.id, new Date());
    expect(await loopEventRepository.hasUnfolded('exec-1')).toBe(false);
  });

  it('records an auto_resumed event without iteration or confidence, and still requires them on unsure', async () => {
    await loopEventRepository.recordAutoResumed({
      loopId: LOOP,
      userId: USER,
      executionId: 'exec-1',
      reason: 'Daily budget reset',
      requestedAt: new Date(5000),
    });
    const [event] = await loopEventRepository.listForLoop(USER, LOOP, 10);
    expect(event).toMatchObject({ kind: 'auto_resumed', reason: 'Daily budget reset' });
    expect(event.confidence).toBeUndefined();

    await expect(
      LoopEvent.create({ ...fields({ executionId: 'exec-2' }), iteration: undefined, kind: 'unsure' })
    ).rejects.toThrow(/iteration/);
  });

  it("listForLoop is owner-scoped and deleteManyForLoop removes only that loop's events", async () => {
    await loopEventRepository.recordUnsure(fields());
    await loopEventRepository.recordUnsure(fields({ executionId: 'exec-2', loopId: 'loop-2' }));

    expect(await loopEventRepository.listForLoop('user-2', LOOP, 10)).toEqual([]);
    expect(await loopEventRepository.deleteManyForLoop(USER, LOOP)).toBe(1);
    expect(await loopEventRepository.listForLoop(USER, 'loop-2', 10)).toHaveLength(1);
  });

  it('recordConfigChanged logs an event with no run, and two in one ms on different loops do not collide', async () => {
    const at = new Date(7000);
    await loopEventRepository.recordConfigChanged({ loopId: LOOP, userId: USER, reason: 'budget 1 -> 2', at });
    await loopEventRepository.recordConfigChanged({ loopId: 'loop-2', userId: USER, reason: 'model a -> b', at });
    await loopEventRepository.recordUnsure(fields({ requestedAt: new Date(8000) }));

    const since = await loopEventRepository.listForLoopSince(USER, LOOP, new Date(0), ['config_changed'], 10);
    expect(since).toHaveLength(1);
    expect(since[0]).toMatchObject({ kind: 'config_changed', reason: 'budget 1 -> 2', requestedAt: at });
    expect(await loopEventRepository.listForLoopSince(USER, LOOP, new Date(0), undefined, 10)).toHaveLength(2);
    expect(await loopEventRepository.hasUnfolded(since[0].executionId)).toBe(false);
  });

  it('a versioned config change lists newest first, is owner-scoped, and is marked undone once', async () => {
    const config = { by: 'coach' as const, before: { budgetCreditsPerDay: 100 }, after: { budgetCreditsPerDay: 125 } };
    const first = await loopEventRepository.recordConfigChanged({
      loopId: LOOP,
      userId: USER,
      reason: 'budget 100 -> 125',
      config: { ...config, suggestionKey: 'raise_budget' },
      at: new Date(1000),
    });
    const second = await loopEventRepository.recordConfigChanged({
      loopId: LOOP,
      userId: USER,
      reason: 'trial kept',
      config: { by: 'trial', before: {}, after: {} },
      at: new Date(2000),
    });
    await loopEventRepository.recordUnsure(fields());

    const listed = await loopEventRepository.listConfigChanges(USER, LOOP, 10);
    expect(listed.map(event => event.id)).toEqual([second, first]);
    expect(listed[1].config).toMatchObject({ ...config, suggestionKey: 'raise_budget' });
    expect(await loopEventRepository.listConfigChanges('user-2', LOOP, 10)).toEqual([]);
    expect(await loopEventRepository.findConfigChange(first, 'user-2', LOOP)).toBeNull();
    expect(await loopEventRepository.findConfigChange('nope', USER, LOOP)).toBeNull();

    expect(await loopEventRepository.markConfigUndone(first, 'undo-1')).toBe(true);
    expect(await loopEventRepository.markConfigUndone(first, 'undo-2')).toBe(false);
    expect((await loopEventRepository.findConfigChange(first, USER, LOOP))?.config?.undoneBy).toBe('undo-1');
  });

  it('listUnresolvedUnsure lists only the open questions and gates of the loop', async () => {
    await loopEventRepository.recordUnsure(fields({ executionId: 'open' }));
    await loopEventRepository.resolveUnsure(fields({ executionId: 'done' }), { outcome: 'resumed', at: new Date() });
    await loopEventRepository.recordUnsure(fields({ executionId: 'other', loopId: 'loop-2' }));
    const open = await loopEventRepository.listUnresolvedUnsure(USER, LOOP, 10);
    expect(open.map(event => event.executionId)).toEqual(['open']);
  });

  it('recordHandoff writes an out row on the source loop and an in row on the target', async () => {
    const at = new Date(5000);
    const base = {
      userId: USER,
      fromLoop: { id: 'a', name: 'QA' },
      toLoop: { id: 'b', name: 'Factory' },
      workItemId: 'ticket-1',
      ticketTitle: 'Bug',
      stage: 'todo',
      by: 'run' as const,
      executionId: 'exec-1',
      note: 'repro attached',
      at,
    };
    await loopEventRepository.recordHandoff(base);
    // A second hand-off of the same ticket at another time is its own pair.
    await loopEventRepository.recordHandoff({ ...base, at: new Date(6000) });
    const [out] = await loopEventRepository.listForLoop(USER, 'a', 1);
    const [incoming] = await loopEventRepository.listForLoop(USER, 'b', 1);
    expect(out).toMatchObject({
      kind: 'handoff',
      workItemId: 'ticket-1',
      handoff: { direction: 'out', otherLoopId: 'b', otherLoopName: 'Factory', executionId: 'exec-1' },
    });
    expect(incoming.handoff).toMatchObject({ direction: 'in', otherLoopId: 'a', note: 'repro attached' });
    expect(await loopEventRepository.hasUnfolded(out.executionId)).toBe(false);
    expect(await LoopEvent.countDocuments({ kind: 'handoff' })).toBe(4);
  });

  describe('asked events', () => {
    const asked = (overrides: Record<string, unknown> = {}) => ({
      source: 'asked' as const,
      loopId: LOOP,
      userId: USER,
      executionId: 'exec-ask',
      workItemId: 'ticket-1',
      ticketTitle: 'Research X',
      reason: 'Which region?',
      requestedAt: new Date(1000),
      ...overrides,
    });

    it('validates without iteration or confidence, and a legacy event without source still validates', async () => {
      await expect(LoopEvent.create({ ...asked(), kind: 'unsure' })).resolves.toBeDefined();
      await expect(
        LoopEvent.create({ ...fields({ executionId: 'exec-legacy' }), kind: 'unsure' })
      ).resolves.toBeDefined();
      await expect(
        LoopEvent.create({
          ...fields({ executionId: 'exec-gate' }),
          source: 'gate',
          confidence: undefined,
          kind: 'unsure',
        })
      ).rejects.toThrow(/confidence/);
    });

    it('resolveAsked resolves once, marks it folded, and refuses gate events', async () => {
      await loopEventRepository.recordUnsure(asked());
      await loopEventRepository.recordUnsure(fields());
      const [askedEvent, gateEvent] = await LoopEvent.find({}).sort({ executionId: -1 });

      const at = new Date(2000);
      const resolved = await loopEventRepository.resolveAsked(askedEvent.id, USER, LOOP, {
        outcome: 'resumed',
        by: USER,
        at,
        note: 'EU',
      });
      expect(resolved).toMatchObject({ resolution: { outcome: 'resumed', note: 'EU' }, foldedAt: at });
      expect(await loopEventRepository.resolveAsked(askedEvent.id, USER, LOOP, { outcome: 'rejected', at })).toBeNull();
      expect(await loopEventRepository.resolveAsked(gateEvent.id, USER, LOOP, { outcome: 'rejected', at })).toBeNull();
      expect(await loopEventRepository.resolveAsked('not-an-id', USER, LOOP, { outcome: 'rejected', at })).toBeNull();
      expect(await loopEventRepository.listResumedUnfolded(10)).toEqual([]);
    });

    it('reopenAsked undoes only the resolution written at that time', async () => {
      await loopEventRepository.recordUnsure(asked());
      const event = await LoopEvent.findOne({});
      const at = new Date(4000);
      await loopEventRepository.resolveAsked(event!.id, USER, LOOP, { outcome: 'resumed', at, note: 'EU' });

      await loopEventRepository.reopenAsked(event!.id, new Date(5000));
      expect((await LoopEvent.findById(event!.id))!.resolution?.outcome).toBe('resumed');

      await loopEventRepository.reopenAsked(event!.id, at);
      const reopened = (await LoopEvent.findById(event!.id))!.toJSON();
      expect(reopened.resolution).toBeUndefined();
      expect(reopened.foldedAt).toBeUndefined();
      expect(await loopEventRepository.resolveAsked(event!.id, USER, LOOP, { outcome: 'rejected', at })).not.toBeNull();
    });

    it("listAnsweredForTicket returns the ticket's answered asks, newest first", async () => {
      const at = new Date(3000);
      for (const [executionId, note] of [
        ['exec-a', 'first'],
        ['exec-b', 'second'],
        ['exec-c', undefined],
      ] as const) {
        await loopEventRepository.recordUnsure(asked({ executionId }));
        const event = await LoopEvent.findOne({ executionId });
        await loopEventRepository.resolveAsked(event!.id, USER, LOOP, {
          outcome: note ? 'resumed' : 'rejected',
          at,
          ...(note && { note }),
        });
      }
      await loopEventRepository.recordUnsure(asked({ executionId: 'exec-d', workItemId: 'ticket-2' }));

      const answered = await loopEventRepository.listAnsweredForTicket(USER, 'ticket-1', 5);
      expect(answered.map(event => event.resolution?.note)).toEqual(['second', 'first']);
      expect(await loopEventRepository.listAnsweredForTicket('user-2', 'ticket-1', 5)).toEqual([]);
    });
  });
});
