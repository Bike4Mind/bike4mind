import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { adminSettingsRepository, agentExecutionRepository, Loop } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/**
 * Real-Mongo tests for the loop scheduler: claiming, leasing and folding are all
 * conditional writes, so their guarantees only mean something against a mongod.
 * The executor dispatch is mocked; execution docs are stubbed through findById.
 */

const h = vi.hoisted(() => ({ startAgentExecution: vi.fn() }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution: h.startAgentExecution }));

import { MAX_CONSECUTIVE_FAILURES, runLoopSchedulerTick } from './loopScheduler';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const NOW = new Date('2026-10-29T12:00:00Z');
const PAST = new Date(NOW.getTime() - 1000);

let mongoServer: MongoMemoryServer;
let executions: Record<string, Record<string, unknown>>;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(() => {
  executions = {};
  vi.spyOn(adminSettingsRepository, 'getSettingsValue').mockImplementation(
    (async (key: string) => key === 'EnableLoops') as never
  );
  vi.spyOn(agentExecutionRepository, 'findById').mockImplementation(
    (async (id: string) => executions[id] ?? null) as never
  );
  let n = 0;
  h.startAgentExecution.mockImplementation(async () => ({ ok: true, executionId: `exec-${++n}` }));
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.restoreAllMocks();
  h.startAgentExecution.mockReset();
});

const createLoop = async (overrides: Record<string, unknown> = {}) =>
  (
    await Loop.create({
      userId: 'user-1',
      name: 'Digest',
      goal: 'Summarize the inbox',
      model: 'claude-sonnet-5',
      sessionId: 'session-1',
      intervalMinutes: 15,
      tools: ['web_search', 'mcp__srv__do_thing'],
      status: 'live',
      nextRunAt: PAST,
      ...overrides,
    })
  ).toJSON();

const reload = async (id: string) => (await Loop.findById(id))!.toJSON();

describe('runLoopSchedulerTick', () => {
  it('dispatches only due live loops, headless, with the loop tools and its notebook', async () => {
    const due = await createLoop();
    await createLoop({ status: 'paused' });
    await createLoop({ status: 'draft' });
    await createLoop({ nextRunAt: new Date(NOW.getTime() + 60_000) });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      sessionId: 'session-1',
      questId: 'session-1',
      query: 'Summarize the inbox',
      connectionId: 'headless',
      apiKeyInfo: undefined,
      enabledTools: ['web_search', 'mcp__srv__do_thing'],
    });
    const after = await reload(due.id);
    expect(after).toMatchObject({ lastExecutionId: 'exec-1', activeExecutionId: 'exec-1' });
    expect(after.nextRunAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    expect(after.leaseUntil).toBeUndefined();
  });

  it('claims and dispatches nothing when EnableLoops is off', async () => {
    vi.mocked(adminSettingsRepository.getSettingsValue).mockResolvedValue(false as never);
    const loop = await createLoop();

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect((await reload(loop.id)).leaseUntil).toBeUndefined();
  });

  it('starts exactly one run when two ticks race', async () => {
    await createLoop();
    await Promise.all([runLoopSchedulerTick(NOW, logger), runLoopSchedulerTick(NOW, logger)]);
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
  });

  it('does not re-dispatch a loop whose last run is still active, even past its lease', async () => {
    await createLoop({ activeExecutionId: 'exec-0', leaseUntil: PAST });
    executions['exec-0'] = { status: 'running', updatedAt: NOW };

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
  });

  it('pauses the loop when its run was refused for credits', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: new Date(NOW.getTime() + 60_000) });
    executions['exec-0'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after).toMatchObject({ status: 'paused', statusReason: 'Out of credits' });
    expect(after.activeExecutionId).toBeUndefined();
  });

  it('keeps a failing loop live until the failure limit, then moves it to error', async () => {
    const loop = await createLoop({
      activeExecutionId: 'exec-0',
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 2,
      nextRunAt: new Date(NOW.getTime() + 60_000),
    });
    executions['exec-0'] = { status: 'failed', error: { message: 'LLM API returned 500' } };
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'live', statusReason: 'LLM API returned 500' });

    await Loop.updateOne({ _id: loop.id }, { $set: { activeExecutionId: 'exec-00' } });
    executions['exec-00'] = { status: 'aborted' };
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'error', statusReason: 'Run aborted' });
  });

  it('folds a run that went quiet past the stale threshold as a failure', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: new Date(NOW.getTime() + 60_000) });
    executions['exec-0'] = { status: 'running', updatedAt: new Date(NOW.getTime() - 60 * 60_000) };

    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ statusReason: 'Run stalled', consecutiveFailures: 1 });
  });

  it('releases the lease on concurrent_limit so the next tick retries', async () => {
    const loop = await createLoop();
    h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'concurrent_limit', message: 'busy' });

    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after.leaseUntil).toBeUndefined();
    expect(after.nextRunAt).toEqual(PAST);
    expect(after.status).toBe('live');
  });

  it('parks the loop at needs_you when its notebook is gone', async () => {
    const loop = await createLoop();
    h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'session_not_found', message: 'Session not found' });

    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ status: 'needs_you', statusReason: 'Session not found' });
  });

  it('feeds the memory written by run N into the prompt of run N+1', async () => {
    const loop = await createLoop();
    await runLoopSchedulerTick(NOW, logger);
    expect(h.startAgentExecution.mock.calls[0][0].systemContext).toContain('(none - this is the first run)');

    executions['exec-1'] = {
      status: 'completed',
      completedAt: NOW,
      result: { answer: 'Did it.\n```loop-memory\n{"notes":"triaged 4 emails","nextAction":"reply to Bob"}\n```' },
    };
    const later = new Date(NOW.getTime() + 16 * 60_000);
    await runLoopSchedulerTick(later, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(2);
    const context = h.startAgentExecution.mock.calls[1][0].systemContext;
    expect(context).toContain('triaged 4 emails');
    expect(context).toContain('reply to Bob');
    expect(await reload(loop.id)).toMatchObject({ runCount: 1, lastExecutionId: 'exec-2' });
  });

  it('still advances a run whose answer has no memory block', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: new Date(NOW.getTime() + 60_000) });
    executions['exec-0'] = { status: 'completed', result: { answer: 'plain answer' } };

    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ runCount: 1, memory: { notes: 'plain answer', nextAction: '' } });
  });
});
