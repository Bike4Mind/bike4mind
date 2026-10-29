import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { adminSettingsRepository, agentExecutionRepository, Loop, loopRepository, WorkItem } from '@bike4mind/database';
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

import { LOOP_LEASE_MS, MAX_CONSECUTIVE_FAILURES, runLoopSchedulerTick } from './loopScheduler';

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
      query: expect.stringMatching(/^Summarize the inbox\n/),
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
    executions['exec-0'] = { status: 'failed', error: { message: 'LLM API returned 500', callerSafe: true } };
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'live', statusReason: 'LLM API returned 500' });

    await Loop.updateOne({ _id: loop.id }, { $set: { activeExecutionId: 'exec-00' } });
    executions['exec-00'] = { status: 'aborted' };
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'error', statusReason: 'Run aborted' });
  });

  it('never shows the owner a raw executor error', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: new Date(NOW.getTime() + 60_000) });
    executions['exec-0'] = {
      status: 'failed',
      error: { message: 'connect ECONNREFUSED internal-db.cluster.local:27017' },
    };

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).statusReason).toBe('Agent execution failed');
  });

  it('records a run whose execution doc is gone as a failure', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: new Date(NOW.getTime() + 60_000) });
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ statusReason: 'Run not found', consecutiveFailures: 1 });
  });

  it('does not move a loop the owner paused to error', async () => {
    const loop = await createLoop({
      status: 'paused',
      activeExecutionId: 'exec-0',
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
    });
    executions['exec-0'] = { status: 'aborted' };

    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ status: 'paused', consecutiveFailures: MAX_CONSECUTIVE_FAILURES });
  });

  it('never stale-folds a run that is waiting on its children', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0' });
    executions['exec-0'] = { status: 'awaiting_subagent', updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000) };

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).activeExecutionId).toBe('exec-0');
    expect(h.startAgentExecution).not.toHaveBeenCalled();
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

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    const after = await reload(loop.id);
    expect(after.leaseUntil).toBeUndefined();
    expect(after.nextRunAt).toEqual(PAST);
    expect(after.status).toBe('live');
  });

  it('does not let a loop that could not start block the other due loops', async () => {
    const stuck = await createLoop({ nextRunAt: new Date(PAST.getTime() - 60_000) });
    const other = await createLoop({ userId: 'user-2' });
    h.startAgentExecution.mockResolvedValueOnce({ ok: false, reason: 'dispatch_failed', message: 'invoke failed' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution.mock.calls.map(([input]) => input.userId)).toEqual(['user-1', 'user-2']);
    expect((await reload(stuck.id)).leaseUntil).toBeUndefined();
    expect((await reload(other.id)).activeExecutionId).toBe('exec-1');
  });

  it('tracks a dispatch_failed run that already has an execution doc', async () => {
    const loop = await createLoop();
    h.startAgentExecution.mockResolvedValue({
      ok: false,
      reason: 'dispatch_failed',
      message: 'unconfirmed',
      executionId: 'exec-7',
    });

    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after).toMatchObject({ activeExecutionId: 'exec-7', lastExecutionId: 'exec-7' });
    expect(after.nextRunAt).toEqual(NOW);
  });

  it('releases the lease when starting the run throws', async () => {
    const loop = await createLoop();
    h.startAgentExecution.mockRejectedValue(new Error('db down'));

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect((await reload(loop.id)).leaseUntil).toBeUndefined();
  });

  it('keeps the lease when a started run could not be recorded', async () => {
    const loop = await createLoop();
    vi.spyOn(loopRepository, 'markDispatched').mockRejectedValue(new Error('db blip'));

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect((await reload(loop.id)).leaseUntil).toEqual(new Date(NOW.getTime() + LOOP_LEASE_MS));
  });

  it('parks the loop at needs_you when its notebook is gone', async () => {
    const loop = await createLoop();
    h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'session_not_found', message: 'Session not found' });

    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ status: 'needs_you', statusReason: 'Session not found' });
  });

  it('keeps an owner pause that lands while a refused dispatch is in flight', async () => {
    const loop = await createLoop();
    h.startAgentExecution.mockImplementation(async () => {
      await Loop.updateOne({ _id: loop.id }, { $set: { status: 'paused' } });
      return { ok: false, reason: 'session_not_found', message: 'Session not found' };
    });

    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after.status).toBe('paused');
    expect(after.leaseUntil).toBeUndefined();
  });

  it('feeds the memory written by run N into the prompt of run N+1', async () => {
    const loop = await createLoop();
    await runLoopSchedulerTick(NOW, logger);
    expect(h.startAgentExecution.mock.calls[0][0].query).toContain('(none - this is the first run)');
    // Model-written memory must never reach the system message.
    expect(h.startAgentExecution.mock.calls[0][0].systemContext).toBeUndefined();

    executions['exec-1'] = {
      status: 'completed',
      completedAt: NOW,
      result: { answer: 'Did it.\n```loop-memory\n{"notes":"triaged 4 emails","nextAction":"reply to Bob"}\n```' },
    };
    const later = new Date(NOW.getTime() + 16 * 60_000);
    await runLoopSchedulerTick(later, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(2);
    const context = h.startAgentExecution.mock.calls[1][0].query;
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

describe('runLoopSchedulerTick - tickets', () => {
  const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
    (
      await WorkItem.create({
        userId: 'user-1',
        loopId,
        title: 'Write the summary',
        stage: 'todo',
        status: 'open',
        dependencies: [],
        ...overrides,
      })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const LATER = new Date(NOW.getTime() + 60 * 60_000);

  it('a ready ticket makes the loop due, runs it and links the run', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    await loopRepository.makeDueNow(loop.id, NOW);

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    const input = h.startAgentExecution.mock.calls[0][0];
    expect(input).toMatchObject({ loopId: loop.id });
    expect(input.query).toContain(`Ticket id: ${ticket.id}`);
    expect(input.query).toContain('Title: "Write the summary"');
    expect(input).not.toHaveProperty('systemContext');
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'in_progress', executionId: 'exec-1' });
  });

  it('waits for a dependency in another loop to close', async () => {
    const other = await createLoop({ nextRunAt: LATER });
    const blocker = await createTicket(other.id);
    const loop = await createLoop();
    const waiting = await createTicket(loop.id, { dependencies: [blocker.id] });

    await runLoopSchedulerTick(NOW, logger);

    // The loop still runs, as a plain goal run; its ticket stays open.
    expect(h.startAgentExecution.mock.calls[0][0].query).not.toContain('Ticket id:');
    expect(await ticketOf(waiting.id)).toMatchObject({ status: 'open' });
  });

  it('a completed run advances its ticket, and from the second-to-last stage closes it', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: LATER });
    const ticket = await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0' });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);
    // Reconcile runs before claim, so the advanced ticket is picked again in the same tick.
    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'doing', status: 'in_progress', executionId: 'exec-1' });
    expect(h.startAgentExecution.mock.calls[0][0].query).toContain('Current stage: doing');

    executions['exec-1'] = { status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);
    const closed = await ticketOf(ticket.id);
    expect(closed).toMatchObject({ stage: 'done', status: 'closed' });
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it('a failed run blocks its ticket; an out-of-credits run returns it to open', async () => {
    const failing = await createLoop({ activeExecutionId: 'exec-f', nextRunAt: LATER });
    const blocked = await createTicket(failing.id, { status: 'in_progress', executionId: 'exec-f' });
    executions['exec-f'] = { status: 'aborted' };
    const broke = await createLoop({ activeExecutionId: 'exec-c', nextRunAt: LATER });
    const reopened = await createTicket(broke.id, { status: 'in_progress', executionId: 'exec-c' });
    executions['exec-c'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(blocked.id)).toMatchObject({ status: 'blocked', statusReason: 'Run aborted' });
    expect(await ticketOf(reopened.id)).toMatchObject({ status: 'open', stage: 'todo' });
    expect(await reload(broke.id)).toMatchObject({ status: 'paused' });
  });

  it('respects a ticket the run blocked itself', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: LATER });
    const ticket = await createTicket(loop.id, {
      status: 'blocked',
      statusReason: 'needs a login',
      executionId: 'exec-0',
    });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({
      status: 'blocked',
      statusReason: 'needs a login',
      stage: 'todo',
    });
  });

  it('runs the next ready ticket right after a fold, and waits the interval when none is left', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: LATER });
    await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0' });
    const next = await createTicket(loop.id, { title: 'Next one' });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);

    // The folded ticket (now in "doing") and the next one are both ready; the older one goes first.
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0].query).not.toContain(next.id);

    const quiet = await createLoop({ activeExecutionId: 'exec-q', nextRunAt: LATER });
    await createTicket(quiet.id, { stage: 'doing', status: 'in_progress', executionId: 'exec-q' });
    executions['exec-q'] = { status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(quiet.id)).nextRunAt).toEqual(LATER);
  });

  it('reopens the ticket when the run could not start', async () => {
    h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'concurrent_limit', message: 'busy' });
    const loop = await createLoop();
    const ticket = await createTicket(loop.id);

    await runLoopSchedulerTick(NOW, logger);

    const after = await ticketOf(ticket.id);
    expect(after.status).toBe('open');
    expect(after.executionId).toBeUndefined();
  });
});
