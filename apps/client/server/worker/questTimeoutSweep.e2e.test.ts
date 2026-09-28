import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Quest, questRepository } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { emitMetric } from '@server/utils/cloudwatch';
import { resolveQuestTimeoutRecovery } from '@server/chatCompletion/questTimeoutRecovery';
import * as sweepModule from '@server/cron/questTimeoutSweep';
import { SelfHostWorker } from './selfHostWorker';
import { QUEST_TIMEOUT_SWEEP_INTERVAL_MS, registerQuestTimeoutSweep } from './questTimeoutSweep';

vi.mock('sst', () => ({ Resource: { App: { stage: 'selfhost' } } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'unused' } }));
vi.mock('@server/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetric: vi.fn() }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const now = new Date('2026-09-25T00:00:00Z');
let server: MongoMemoryServer;
const workers: SelfHostWorker[] = [];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(1000);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(emitMetric).mockClear();
  // Not dropDatabase: mongoose reads a heartbeat stamped under the fake clock as a stale
  // connection once real time returns, and that call then buffers until it times out.
  await Quest.collection.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

async function seed(ageMs: number, fields: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Quest.collection.insertOne({
    _id,
    sessionId: new mongoose.Types.ObjectId().toString(),
    type: 'message',
    status: 'running',
    replies: [],
    createdAt: new Date(now.getTime() - ageMs),
    updatedAt: new Date(now.getTime() - ageMs),
    ...fields,
  });
  return _id;
}
const quest = (_id: mongoose.Types.ObjectId) => Quest.collection.findOne({ _id });
// Above vi.waitFor's 1s default so a loaded host running the whole lane cannot fail a correct sweep.
const SETTLE_WAIT = { timeout: 10_000 };
function start(enabled: boolean) {
  const worker = new SelfHostWorker();
  workers.push(worker);
  if (enabled) registerQuestTimeoutSweep(worker);
  worker.start();
  return worker;
}

describe('self-host quest timeout sweep against Mongo', () => {
  it('settles a stale running quest with no client request and leaves fresh ones alone', async () => {
    const stale = await seed(5 * MINUTE);
    const staleWithAnswer = await seed(5 * MINUTE, { replies: ['partial answer'] });
    const fresh = await seed(30 * SECOND);
    const beyondFloor = await seed(8 * DAY);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);

    const disabled = start(false);
    await vi.advanceTimersByTimeAsync(QUEST_TIMEOUT_SWEEP_INTERVAL_MS);
    expect((await quest(stale))?.status).toBe('running');
    await disabled.stop();

    vi.setSystemTime(now);
    start(true);
    await vi.waitFor(async () => {
      expect(await quest(stale)).toMatchObject({ status: 'done', type: 'error' });
      expect(await quest(staleWithAnswer)).toMatchObject({ status: 'done', replies: ['partial answer'] });
    }, SETTLE_WAIT);
    expect((await quest(stale))?.reply).toMatch(/timed out/);
    expect((await quest(staleWithAnswer))?.type).toBe('message');
    expect((await quest(fresh))?.status).toBe('running');
    expect((await quest(beyondFloor))?.status).toBe('running');
    expect(emitMetric).not.toHaveBeenCalled();
  });

  it('settles a quest that goes stale after startup on the next 5-minute tick', async () => {
    const later = await seed(MINUTE);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);
    const sweep = vi.spyOn(sweepModule, 'runQuestTimeoutSweep');

    start(true);
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledOnce(), SETTLE_WAIT);
    await sweep.mock.results[0].value;
    expect((await quest(later))?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(QUEST_TIMEOUT_SWEEP_INTERVAL_MS);
    await vi.waitFor(async () => {
      expect(await quest(later)).toMatchObject({ status: 'done', type: 'error' });
    }, SETTLE_WAIT);
  });

  it('leaves a quest to whichever writer settles it first between the sweep read and write', async () => {
    const completed = await seed(5 * MINUTE);
    const recoveredOnRead = await seed(5 * MINUTE, { replies: ['partial answer'] });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const find = questRepository.findStaleRunning.bind(questRepository);
    vi.spyOn(questRepository, 'findStaleRunning').mockImplementationOnce(async options => {
      const candidates = await find(options);
      expect(candidates.map(c => c.id).sort()).toEqual([completed.toString(), recoveredOnRead.toString()].sort());
      // The run commits its real answer, and a client's read-time recovery settles the other.
      await Quest.collection.updateOne({ _id: completed }, { $set: { status: 'done', reply: 'real answer' } });
      const onRead = candidates.find(c => c.id === recoveredOnRead.toString())!;
      await questRepository.update({ id: onRead.id, ...resolveQuestTimeoutRecovery(onRead, now.getTime())! });
      return candidates;
    });

    const result = await sweepModule.runQuestTimeoutSweep({ emitMetrics: false });

    expect(result.recovered).toBe(0);
    expect(await quest(completed)).toMatchObject({ status: 'done', reply: 'real answer' });
    expect((await quest(completed))?.type).toBe('message');
    expect(await quest(recoveredOnRead)).toMatchObject({
      status: 'done',
      type: 'message',
      replies: ['partial answer'],
    });
  });
});
