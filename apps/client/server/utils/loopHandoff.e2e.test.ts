import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Loop, LoopEvent, WorkItem, workItemRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/** Real-Mongo tests for hand-offs and stage triggers: both lean on conditional writes and a unique index. */

const h = vi.hoisted(() => ({ requestLoopDispatch: vi.fn(), pushLoopChanged: vi.fn() }));
vi.mock('./loopDispatch', () => h);

import { fireStageTriggers, handoffTicket, MAX_HANDOFFS_PER_TICKET } from './loopHandoff';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const USER = 'user-1';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await WorkItem.syncIndexes();
  await LoopEvent.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(() => {
  h.requestLoopDispatch.mockResolvedValue(undefined);
  h.pushLoopChanged.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all([Loop.deleteMany({}), WorkItem.deleteMany({}), LoopEvent.deleteMany({})]);
  vi.clearAllMocks();
});

const createLoop = async (name: string, overrides: Record<string, unknown> = {}) =>
  (
    await Loop.create({
      userId: USER,
      name,
      goal: 'Work the backlog',
      model: 'm',
      sessionId: 's',
      intervalMinutes: 60,
      status: 'live',
      nextRunAt: new Date(Date.now() + 60 * 60_000),
      stages: ['todo', 'doing', 'done'],
      ...overrides,
    })
  ).toJSON();

const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
  (
    await WorkItem.create({
      userId: USER,
      loopId,
      title: 'Fix the bug',
      description: 'Steps attached',
      status: 'open',
      stage: 'doing',
      dependencies: [],
      priority: 'p1',
      prioritySetBy: 'owner',
      runCount: 2,
      ...overrides,
    })
  ).toJSON();

const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();

describe('handoffTicket', () => {
  it("a run moves its loop's ticket to an allowed loop, keeping priority and dependencies, and logs both loops", async () => {
    const factory = await createLoop('Factory');
    const qa = await createLoop('QA', { handoffTargets: [factory.id] });
    const ticket = await createTicket(qa.id, {
      dependencies: ['dep-1'],
      status: 'blocked',
      blockedOn: 'dependencies',
      statusReason: 'held',
      executionId: 'old-run',
    });

    const { ticket: moved, capped } = await handoffTicket({
      userId: USER,
      ticketId: ticket.id,
      fromLoopId: qa.id,
      toLoopId: factory.id,
      by: 'run',
      executionId: 'exec-1',
      note: 'repro in the description',
      logger,
    });

    expect(capped).toBeUndefined();
    expect(moved).toMatchObject({
      loopId: factory.id,
      stage: 'todo',
      status: 'open',
      priority: 'p1',
      prioritySetBy: 'owner',
      dependencies: ['dep-1'],
      runCount: 0,
      handoffCount: 1,
      handoffs: [
        {
          fromLoopId: qa.id,
          fromLoopName: 'QA',
          toLoopId: factory.id,
          toLoopName: 'Factory',
          stage: 'todo',
          by: 'run',
          executionId: 'exec-1',
          note: 'repro in the description',
        },
      ],
    });
    expect(moved.executionId).toBeUndefined();
    expect(moved.statusReason).toBeUndefined();
    expect(moved.blockedOn).toBeUndefined();
    const events = (await LoopEvent.find({ kind: 'handoff' })).map(doc => doc.toJSON());
    expect(events.map(e => [e.loopId, e.handoff?.direction])).toEqual(
      expect.arrayContaining([
        [qa.id, 'out'],
        [factory.id, 'in'],
      ])
    );
    expect((await Loop.findById(factory.id))!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(h.requestLoopDispatch).toHaveBeenCalledWith(factory.id, logger);
  });

  it('lands in a named stage', async () => {
    const factory = await createLoop('Factory');
    const qa = await createLoop('QA', { handoffTargets: [factory.id] });
    const ticket = await createTicket(qa.id);
    const { ticket: moved } = await handoffTicket({
      userId: USER,
      ticketId: ticket.id,
      fromLoopId: qa.id,
      toLoopId: factory.id,
      stage: 'doing',
      by: 'run',
      logger,
    });
    expect(moved.stage).toBe('doing');
  });

  it("closes the source loop's open question on the ticket as handed off, and leaves others alone", async () => {
    const factory = await createLoop('Factory');
    const qa = await createLoop('QA');
    const ticket = await createTicket(qa.id, { status: 'blocked', statusReason: 'Unsure: Which release?' });
    const other = await createTicket(qa.id, { status: 'blocked', statusReason: 'Unsure: Which branch?' });
    const asked = (workItemId: string, executionId: string, reason: string) =>
      LoopEvent.create({
        userId: USER,
        loopId: qa.id,
        kind: 'unsure',
        source: 'asked',
        executionId,
        workItemId,
        reason,
        requestedAt: new Date(),
      });
    await asked(ticket.id, 'exec-1', 'Which release?');
    await asked(other.id, 'exec-2', 'Which branch?');

    await handoffTicket({
      userId: USER,
      ticketId: ticket.id,
      fromLoopId: qa.id,
      toLoopId: factory.id,
      by: 'owner',
      logger,
    });

    const [closed, open] = await Promise.all([
      LoopEvent.findOne({ executionId: 'exec-1' }),
      LoopEvent.findOne({ executionId: 'exec-2' }),
    ]);
    expect(closed!.resolution).toMatchObject({ outcome: 'handed_off' });
    expect(closed!.foldedAt).toBeInstanceOf(Date);
    expect(open!.resolution).toBeUndefined();
  });

  it('refuses each case with a reason and leaves the ticket unchanged', async () => {
    const factory = await createLoop('Factory', {
      stageConfig: [{ stage: 'doing', runner: 'desktop' }],
    });
    const foreign = await createLoop('Theirs', { userId: 'user-2' });
    const other = await createLoop('Other');
    const qa = await createLoop('QA', {
      handoffTargets: [factory.id, foreign.id],
      stageConfig: [{ stage: 'doing', runner: 'desktop' }],
    });
    const open = await createTicket(qa.id, { stage: 'todo' });
    const epic = await createTicket(qa.id, { stage: 'todo', epic: true, status: 'blocked', blockedOn: 'dependencies' });
    const closed = await createTicket(qa.id, { stage: 'done', status: 'closed' });
    const desktop = await createTicket(qa.id, { stage: 'doing' });
    const ownerBlocked = await createTicket(qa.id, {
      stage: 'todo',
      status: 'blocked',
      statusReason: 'Unsure: Which release?',
    });
    const run = (ticketId: string, toLoopId: string, stage?: string) =>
      handoffTicket({ userId: USER, ticketId, fromLoopId: qa.id, toLoopId, stage, by: 'run', logger });

    await expect(run(open.id, other.id)).rejects.toThrow(/handoffTargets/);
    await expect(run(open.id, foreign.id)).rejects.toThrow('Loops can only hand off to your own loops for now');
    await expect(run(epic.id, factory.id)).rejects.toThrow(/epic/);
    await expect(run(closed.id, factory.id)).rejects.toThrow(/closed/);
    await expect(run(desktop.id, factory.id)).rejects.toThrow(/desktop app/);
    await expect(run(ownerBlocked.id, factory.id)).rejects.toThrow(/blocked for the owner/);
    await expect(run(open.id, factory.id, 'nope')).rejects.toThrow(/stage must be one of/);
    await expect(run(open.id, factory.id, 'done')).rejects.toThrow(/last stage/);

    expect((await ticketOf(open.id)).loopId).toBe(qa.id);
    expect((await ticketOf(open.id)).handoffs).toBeUndefined();
    expect(await ticketOf(ownerBlocked.id)).toMatchObject({ loopId: qa.id, status: 'blocked' });
    expect(await LoopEvent.countDocuments({})).toBe(0);
    // Handing into a desktop stage is fine.
    const { ticket: moved } = await run(open.id, factory.id, 'doing');
    expect(moved.stage).toBe('doing');
  });

  it(`the ${MAX_HANDOFFS_PER_TICKET + 1}th run hand-off blocks the ticket in place; an owner hand-off resets the count`, async () => {
    const a = await createLoop('A');
    const b = await createLoop('B', { handoffTargets: [a.id] });
    await Loop.updateOne({ _id: a.id }, { $set: { handoffTargets: [b.id] } });
    const ticket = await createTicket(a.id);
    let at = a.id;
    for (let i = 0; i < MAX_HANDOFFS_PER_TICKET; i++) {
      const to = at === a.id ? b.id : a.id;
      await handoffTicket({ userId: USER, ticketId: ticket.id, fromLoopId: at, toLoopId: to, by: 'run', logger });
      at = to;
    }
    expect((await ticketOf(ticket.id)).handoffCount).toBe(MAX_HANDOFFS_PER_TICKET);

    const to = at === a.id ? b.id : a.id;
    const result = await handoffTicket({
      userId: USER,
      ticketId: ticket.id,
      fromLoopId: at,
      toLoopId: to,
      by: 'run',
      logger,
    });
    expect(result.capped).toMatch(/owner decides/);
    expect(await ticketOf(ticket.id)).toMatchObject({ loopId: at, status: 'blocked', statusReason: result.capped });
    expect((await ticketOf(ticket.id)).blockedOn).toBeUndefined();
    await expect(
      handoffTicket({ userId: USER, ticketId: ticket.id, fromLoopId: at, toLoopId: to, by: 'run', logger })
    ).rejects.toThrow(/blocked for the owner/);

    const { ticket: moved } = await handoffTicket({
      userId: USER,
      ticketId: ticket.id,
      fromLoopId: at,
      toLoopId: to,
      by: 'owner',
      logger,
    });
    expect(moved).toMatchObject({ loopId: to, status: 'open', handoffCount: 0 });
    expect(moved.handoffs?.at(-1)?.by).toBe('owner');
  });
});

describe('fireStageTriggers', () => {
  it('files exactly one linked copy per listener, and nothing on a repeat', async () => {
    const x = await createLoop('X');
    const z = await createLoop('Z', { triggers: [{ fromLoopId: x.id, stage: 'done', toStage: 'doing' }] });
    await createLoop('Unrelated', { triggers: [{ fromLoopId: x.id, stage: 'todo' }] });
    const ticket = await createTicket(x.id, { stage: 'done', status: 'closed', priority: 'p0' });

    await fireStageTriggers({ userId: USER, ticket, loop: x, logger });
    await fireStageTriggers({ userId: USER, ticket, loop: x, logger });

    const copies = (await WorkItem.find({ loopId: z.id })).map(doc => doc.toJSON());
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      title: 'Fix the bug',
      description: 'Steps attached',
      stage: 'doing',
      status: 'open',
      priority: 'p0',
      prioritySetBy: 'agent',
      origin: { loopId: x.id, loopName: 'X', ticketId: ticket.id, stage: 'done', kind: 'trigger', depth: 1 },
    });
    expect((await ticketOf(ticket.id)).handedTo).toEqual([
      expect.objectContaining({ loopId: z.id, loopName: 'Z', ticketId: copies[0].id }),
    ]);
    const inRow = await LoopEvent.findOne({ loopId: z.id, kind: 'handoff' });
    expect(inRow?.toJSON().handoff).toMatchObject({ direction: 'in', via: 'trigger', otherLoopId: x.id });
    expect(h.requestLoopDispatch).toHaveBeenCalledWith(z.id, logger);
  });

  it('a copy of an untriaged ticket stays untriaged', async () => {
    const x = await createLoop('X');
    const z = await createLoop('Z', { triggers: [{ fromLoopId: x.id, stage: 'done' }] });
    const ticket = await createTicket(x.id, {
      stage: 'done',
      status: 'closed',
      priority: undefined,
      prioritySetBy: undefined,
    });
    await fireStageTriggers({ userId: USER, ticket, loop: x, logger });
    const copy = (await WorkItem.findOne({ loopId: z.id }))!.toJSON();
    expect(copy.stage).toBe('todo');
    expect(copy.priority).toBeUndefined();
  });

  it('a chain X -> Z -> X -> Z stops at depth 3 with the copy blocked for the owner', async () => {
    const x = await createLoop('X');
    const z = await createLoop('Z');
    await Loop.updateOne(
      { _id: z.id },
      {
        $set: {
          triggers: [
            { fromLoopId: x.id, stage: 'done' },
            { fromLoopId: x.id, stage: 'todo' },
          ],
        },
      }
    );
    await Loop.updateOne({ _id: x.id }, { $set: { triggers: [{ fromLoopId: z.id, stage: 'todo' }] } });
    const ticket = await createTicket(x.id, { stage: 'done', status: 'closed' });

    await fireStageTriggers({ userId: USER, ticket, loop: (await Loop.findById(x.id))!.toJSON(), logger });

    const all = (await WorkItem.find({ origin: { $exists: true } }).sort({ 'origin.depth': 1 })).map(doc =>
      doc.toJSON()
    );
    expect(all.map(t => [t.loopId, t.origin?.depth, t.status])).toEqual([
      [z.id, 1, 'open'],
      [x.id, 2, 'open'],
      [z.id, 3, 'blocked'],
    ]);
    expect(all[2].statusReason).toMatch(/Trigger chain stopped at depth 3/);
  });

  it('a hand-off that lands in a listened stage fires the trigger', async () => {
    const x = await createLoop('X');
    const qa = await createLoop('QA', { handoffTargets: [x.id] });
    const z = await createLoop('Z', { triggers: [{ fromLoopId: x.id, stage: 'todo' }] });
    const ticket = await createTicket(qa.id);
    await handoffTicket({ userId: USER, ticketId: ticket.id, fromLoopId: qa.id, toLoopId: x.id, by: 'run', logger });
    expect(await WorkItem.countDocuments({ loopId: z.id, 'origin.ticketId': ticket.id })).toBe(1);
  });

  it('one failing listener does not cost the others their copy', async () => {
    const x = await createLoop('X');
    await createLoop('Y', { triggers: [{ fromLoopId: x.id, stage: 'done' }] });
    await createLoop('Z', { triggers: [{ fromLoopId: x.id, stage: 'done' }] });
    const ticket = await createTicket(x.id, { stage: 'done', status: 'closed' });
    const create = vi.spyOn(workItemRepository, 'create').mockRejectedValueOnce(new Error('db down'));
    try {
      await fireStageTriggers({ userId: USER, ticket, loop: x, logger });
    } finally {
      create.mockRestore();
    }
    expect(await WorkItem.countDocuments({ 'origin.ticketId': ticket.id })).toBe(1);
  });

  it('refuses handing a trigger copy into a loop that already holds a copy of the same source', async () => {
    const x = await createLoop('X');
    const y = await createLoop('Y', { triggers: [{ fromLoopId: x.id, stage: 'done' }] });
    const z = await createLoop('Z', { triggers: [{ fromLoopId: x.id, stage: 'done' }] });
    const ticket = await createTicket(x.id, { stage: 'done', status: 'closed' });
    await fireStageTriggers({ userId: USER, ticket, loop: x, logger });
    const copyInZ = (await WorkItem.findOne({ loopId: z.id }))!.toJSON();
    await expect(
      handoffTicket({ userId: USER, ticketId: copyInZ.id, fromLoopId: z.id, toLoopId: y.id, by: 'owner', logger })
    ).rejects.toMatchObject({ message: 'that loop already has a copy of this ticket' });
    expect((await ticketOf(copyInZ.id)).loopId).toBe(z.id);
  });

  it('never fails the caller', async () => {
    const x = await createLoop('X');
    await expect(
      fireStageTriggers({
        userId: USER,
        ticket: { id: 'nope', stage: 'done' } as never,
        loop: { ...x, id: 'bad' },
        logger,
      })
    ).resolves.toBeUndefined();
  });
});
