import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { LoopDirective, loopDirectiveRepository } from './LoopDirectiveModel';

const USER = 'user-1';
const OVERSEER = 'loop-overseer';
const WORKER = 'loop-worker';

const create = (overrides: Record<string, unknown> = {}) =>
  loopDirectiveRepository.create({
    loopId: WORKER,
    userId: USER,
    fromLoopId: OVERSEER,
    fromLoopName: 'Overseer',
    executionId: 'exec-1',
    instruction: 'Stop writing tests',
    reason: 'They are slow',
    state: 'open',
    replies: [],
    ...overrides,
  } as Parameters<typeof loopDirectiveRepository.create>[0]);

const workerReply = (outcome: 'accepted' | 'pushed_back' | 'done', note?: string) => ({
  by: 'worker' as const,
  outcome,
  ...(note && { note }),
  executionId: 'exec-2',
  at: new Date(),
});

describe('LoopDirectiveRepository', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await LoopDirective.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await LoopDirective.deleteMany({});
  });

  it('allows several directives from one run and counts them', async () => {
    await create();
    await create({ instruction: 'Second' });
    await create({ executionId: 'exec-other' });
    expect(await loopDirectiveRepository.countByExecution('exec-1')).toBe(2);
  });

  it('lists open and accepted directives oldest first, and both sides of a loop newest first', async () => {
    const at = (ms: number) => ({ createdAt: new Date(ms) });
    const first = await create({ instruction: 'first', ...at(1000) });
    const second = await create({ instruction: 'second', state: 'accepted', ...at(2000) });
    await create({ instruction: 'done', state: 'done', ...at(3000) });
    await create({ instruction: 'withdrawn', state: 'withdrawn', ...at(4000) });
    const issued = await create({ loopId: 'loop-other', fromLoopId: WORKER, instruction: 'issued', ...at(5000) });
    await create({ userId: 'user-2', instruction: 'foreign', ...at(6000) });

    const open = await loopDirectiveRepository.listOpenForLoop(USER, WORKER, 10);
    expect(open.map(d => d.id)).toEqual([first.id, second.id]);

    const log = await loopDirectiveRepository.listForLoop(USER, WORKER, 10);
    expect(log.map(d => d.instruction)).toEqual(['issued', 'withdrawn', 'done', 'second', 'first']);
    expect((await loopDirectiveRepository.listToLoop(USER, WORKER, 10)).map(d => d.id)).not.toContain(issued.id);
  });

  it('transitions only from the expected states, appending the reply', async () => {
    const directive = await create();
    const accepted = await loopDirectiveRepository.transition(
      directive.id,
      USER,
      ['open'],
      'accepted',
      workerReply('accepted')
    );
    expect(accepted).toMatchObject({ state: 'accepted', replies: [{ by: 'worker', outcome: 'accepted' }] });

    // A second writer that read `open` loses.
    expect(
      await loopDirectiveRepository.transition(directive.id, USER, ['open'], 'done', workerReply('done'))
    ).toBeNull();
    expect(
      await loopDirectiveRepository.transition(directive.id, 'user-2', ['accepted'], 'done', workerReply('done'))
    ).toBeNull();

    const done = await loopDirectiveRepository.transition(
      directive.id,
      USER,
      ['accepted'],
      'done',
      workerReply('done')
    );
    expect(done?.replies.map(r => r.outcome)).toEqual(['accepted', 'done']);
  });

  it('a racing owner withdraw and worker reply never both apply', async () => {
    const directive = await create();
    const results = await Promise.all([
      loopDirectiveRepository.transition(directive.id, USER, ['open', 'accepted', 'pushed_back'], 'withdrawn', {
        by: 'owner',
        outcome: 'withdrawn',
        userId: USER,
        at: new Date(),
      }),
      loopDirectiveRepository.transition(directive.id, USER, ['open'], 'done', workerReply('done')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await loopDirectiveRepository.findByIdForUser(directive.id, USER))?.replies).toHaveLength(1);
  });

  it('findByIdForUser is owner-scoped and tolerates a bad id', async () => {
    const directive = await create();
    expect(await loopDirectiveRepository.findByIdForUser(directive.id, 'user-2')).toBeNull();
    expect(await loopDirectiveRepository.findByIdForUser('not-an-id', USER)).toBeNull();
  });

  it('deleteManyForLoop removes directives to the loop, not those it issued', async () => {
    await create();
    await create({ loopId: 'loop-other', fromLoopId: WORKER });
    expect(await loopDirectiveRepository.deleteManyForLoop(USER, WORKER)).toBe(1);
    expect(await LoopDirective.countDocuments()).toBe(1);
  });
});
