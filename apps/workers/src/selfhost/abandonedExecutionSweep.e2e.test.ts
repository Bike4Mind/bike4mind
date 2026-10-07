import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Quest, agentExecutionRepository, questRepository } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import * as sweepModule from '@workers/cron/agentExecutionAbandonedSweep';
import { SelfHostWorker } from './selfHostWorker';
import { registerAbandonedExecutionSweep } from './abandonedExecutionSweep';

vi.mock('sst', () => ({ Resource: { App: { stage: 'selfhost' } } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'unused' } }));
vi.mock('@server/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetric: vi.fn() }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const HOUR = 60 * 60_000;
// Never fake Date here: mongoose reports a live connection as disconnected once Date.now() runs
// two heartbeat intervals past the last real heartbeat, so a faked clock jump buffers every query.
// Fixtures are aged relative to the real clock instead, and "an hour later" means backdating them.
let now: Date;
let server: MongoMemoryServer;
const workers: SelfHostWorker[] = [];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
beforeEach(() => {
  now = new Date();
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(1000);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const executions = () => mongoose.model('AgentExecution').collection;
async function seed(status: string, ageHours: number) {
  const _id = new mongoose.Types.ObjectId();
  await executions().insertOne({
    _id,
    userId: new mongoose.Types.ObjectId().toString(),
    status,
    updatedAt: new Date(now.getTime() - ageHours * HOUR),
    createdAt: now,
  });
  return _id;
}
async function backdate(_id: mongoose.Types.ObjectId, field: 'updatedAt' | 'questSettlementFailedAt', ms: number) {
  const record = await executions().findOne({ _id });
  const value = record?.[field];
  if (!(value instanceof Date)) throw new Error(`execution ${_id} has no ${field} to backdate`);
  await executions().updateOne({ _id }, { $set: { [field]: new Date(value.getTime() - ms) } });
}
function start(enabled: boolean) {
  const worker = new SelfHostWorker();
  workers.push(worker);
  if (enabled) registerAbandonedExecutionSweep(worker);
  worker.start();
  return worker;
}

describe('self-host abandoned execution recovery against Mongo', () => {
  it('recovers an old continuing execution on startup; disabled registration and exempt records remain unchanged', async () => {
    const stale = await seed('continuing', 8);
    const fresh = await seed('continuing', 1);
    const subagent = await seed('awaiting_subagent', 8);
    const dag = await seed('awaiting_dag_children', 8);
    const questId = new mongoose.Types.ObjectId();
    await Quest.collection.insertOne({ _id: questId, agentExecutionId: stale.toString(), status: 'pending' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const disabled = start(false);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect((await executions().findOne({ _id: stale }))?.status).toBe('continuing');
    expect((await Quest.collection.findOne({ _id: questId }))?.status).toBe('pending');
    await disabled.stop();

    // Await the sweep itself rather than polling Mongo: a poll races real I/O against a wall-clock
    // timeout and loses on a loaded host.
    const sweep = vi.spyOn(sweepModule, 'runAbandonedExecutionSweep');
    start(true);
    expect(sweep).toHaveBeenCalledOnce();
    await sweep.mock.results[0].value;
    expect(await executions().findOne({ _id: stale })).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
    expect(await Quest.collection.findOne({ _id: questId })).toMatchObject({ status: 'done', type: 'error' });
    expect((await executions().findOne({ _id: fresh }))?.status).toBe('continuing');
    expect((await executions().findOne({ _id: subagent }))?.status).toBe('awaiting_subagent');
    expect((await executions().findOne({ _id: dag }))?.status).toBe('awaiting_dag_children');
  });

  it('does not abandon an execution refreshed after candidate selection', async () => {
    const refreshed = await seed('continuing', 8);
    const find = agentExecutionRepository.findStaleActiveIds.bind(agentExecutionRepository);
    vi.spyOn(agentExecutionRepository, 'findStaleActiveIds').mockImplementationOnce(async options => {
      const ids = await find(options);
      expect(ids).toContain(refreshed.toString());
      await executions().updateOne({ _id: refreshed }, { $set: { status: 'running', updatedAt: now } });
      return ids;
    });

    const result = await sweepModule.runAbandonedExecutionSweep({ emitMetrics: false });

    expect(result.marked).toBe(0);
    expect(await executions().findOne({ _id: refreshed })).toMatchObject({ status: 'running', updatedAt: now });
  });

  it('scans newly stale records on the hourly tick after a quiet startup', async () => {
    const later = await seed('continuing', 5.5);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sweep = vi.spyOn(sweepModule, 'runAbandonedExecutionSweep');
    start(true);
    expect(sweep).toHaveBeenCalledOnce();
    await sweep.mock.results[0].value;
    expect((await executions().findOne({ _id: later }))?.status).toBe('continuing');
    await backdate(later, 'updatedAt', HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
    await sweep.mock.results[1].value;
    expect(await executions().findOne({ _id: later })).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
  });

  it('retries a quest settlement that failed on the first tick and settles it on the second', async () => {
    // The bug this whole retry mechanism exists for: markAbandoned already made
    // the execution terminal, so `findStaleActiveIds` can never select it again
    // - a failed settle has no path back except the `questSettlementFailedAt`
    // marker and the retry pass that looks for it.
    const stale = await seed('continuing', 8);
    const questId = new mongoose.Types.ObjectId();
    await Quest.collection.insertOne({ _id: questId, agentExecutionId: stale.toString(), status: 'pending' });

    vi.spyOn(questRepository, 'settleIfUnfinished').mockRejectedValueOnce(new Error('transient mongo blip'));

    const first = await sweepModule.runAbandonedExecutionSweep({ emitMetrics: false });

    expect(first.marked).toBe(1);
    expect(first.questsSettled).toBe(0);
    expect(await executions().findOne({ _id: stale })).toMatchObject({
      status: 'failed',
      failureReason: 'abandoned',
    });
    // The execution write already landed; only the quest settlement failed.
    expect((await executions().findOne({ _id: stale }))?.questSettlementFailedAt).toBeInstanceOf(Date);
    expect((await Quest.collection.findOne({ _id: questId }))?.status).toBe('pending');

    // Tick two, an hour later: no new candidates from findStaleActiveIds (the
    // execution is already terminal), but the retry pass picks up the marker
    // and the mocked failure does not recur.
    // The retry pass only takes markers strictly older than its own tick start, so a tick in the
    // same millisecond as the marker write would skip it.
    await backdate(stale, 'questSettlementFailedAt', HOUR);
    const second = await sweepModule.runAbandonedExecutionSweep({ emitMetrics: false });

    expect(second.marked).toBe(0);
    expect(second.questsSettled).toBe(1);
    expect((await executions().findOne({ _id: stale }))?.questSettlementFailedAt).toBeUndefined();
    expect(await Quest.collection.findOne({ _id: questId })).toMatchObject({
      status: 'done',
      type: 'error',
    });
  });
});
