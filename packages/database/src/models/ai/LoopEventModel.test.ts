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

  it("listForLoop is owner-scoped and deleteManyForLoop removes only that loop's events", async () => {
    await loopEventRepository.recordUnsure(fields());
    await loopEventRepository.recordUnsure(fields({ executionId: 'exec-2', loopId: 'loop-2' }));

    expect(await loopEventRepository.listForLoop('user-2', LOOP, 10)).toEqual([]);
    expect(await loopEventRepository.deleteManyForLoop(USER, LOOP)).toBe(1);
    expect(await loopEventRepository.listForLoop(USER, 'loop-2', 10)).toHaveLength(1);
  });
});
