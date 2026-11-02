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
