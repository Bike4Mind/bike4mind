import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  Inbox,
  Loop,
  LoopEvent,
  loopEventRepository,
  loopRepository,
  organizationRepository,
  userRepository,
  WorkItem,
  workItemRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/**
 * Real-Mongo tests for the loop scheduler: claiming, leasing and folding are all
 * conditional writes, so their guarantees only mean something against a mongod.
 * The executor dispatch is mocked; execution docs are stubbed through findById.
 */

const h = vi.hoisted(() => ({
  startAgentExecution: vi.fn(),
  getAvailableModels: vi.fn(),
  nextIterationCredits: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution: h.startAgentExecution }));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: h.getAvailableModels,
}));
vi.mock('../queueHandlers/agentExecutor.billing', () => ({ nextIterationCredits: h.nextIterationCredits }));

import { BUDGET_PAUSE_REASON, LOOP_LEASE_MS, MAX_CONSECUTIVE_FAILURES, runLoopSchedulerTick } from './loopScheduler';
import { STALE_ACTIVE_MS } from '@server/utils/executionLimits';

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
  h.getAvailableModels.mockReset();
  h.nextIterationCredits.mockReset();
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
    expect(after).toMatchObject({ status: 'paused', statusReason: 'Out of credits', autoResume: 'credits' });
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

  it('releases the lease when claiming a ticket throws', async () => {
    const loop = await createLoop();
    vi.spyOn(workItemRepository, 'findNextReadyForLoop').mockRejectedValue(new Error('db down'));

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
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

describe('runLoopSchedulerTick - unsure', () => {
  const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
    (
      await WorkItem.create({
        userId: 'user-1',
        loopId,
        title: 'Research X',
        stage: 'todo',
        status: 'in_progress',
        executionId: 'exec-0',
        dependencies: [],
        ...overrides,
      })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const eventsOf = async (loopId: string) => loopEventRepository.listForLoop('user-1', loopId, 10);
  const LATER = new Date(NOW.getTime() + 60 * 60_000);
  const gate = (requestedAt: Date, reason = 'thin results') => ({ iteration: 2, confidence: 0.3, reason, requestedAt });
  const paused = (requestedAt = new Date(1000), updatedAt = NOW) => ({
    userId: 'user-1',
    status: 'paused',
    pendingGate: gate(requestedAt),
    updatedAt,
  });

  it('parks a gate-paused run once: event logged, ticket blocked as unsure, loop freed without a failure', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    executions['exec-0'] = paused();

    await runLoopSchedulerTick(NOW, logger);
    await Loop.updateOne({ _id: loop.id }, { $set: { activeExecutionId: 'exec-0' } });
    await runLoopSchedulerTick(NOW, logger);

    const events = await eventsOf(loop.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'unsure',
      executionId: 'exec-0',
      workItemId: ticket.id,
      ticketTitle: 'Research X',
      confidence: 0.3,
      reason: 'thin results',
    });
    expect(events[0].resolution).toBeUndefined();
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'blocked', statusReason: 'Unsure: thin results' });
    const after = await reload(loop.id);
    expect(after).toMatchObject({ status: 'live', consecutiveFailures: 0, runCount: 0 });
    expect(after.activeExecutionId).toBeUndefined();
    expect(after.statusReason).toBeUndefined();
  });

  it('never folds a gate-paused run as stalled', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    executions['exec-0'] = paused(new Date(1000), new Date(NOW.getTime() - STALE_ACTIVE_MS - 60_000));

    await runLoopSchedulerTick(NOW, logger);

    expect((await ticketOf(ticket.id)).statusReason).toBe('Unsure: thin results');
    expect(await reload(loop.id)).toMatchObject({ consecutiveFailures: 0, status: 'live' });
  });

  it("works the loop's next ready ticket while the unsure one stays blocked", async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: LATER });
    const unsure = await createTicket(loop.id);
    const next = await createTicket(loop.id, { title: 'Next one', status: 'open', executionId: undefined });
    executions['exec-0'] = paused();

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0].query).toContain(`Ticket id: ${next.id}`);
    expect(await ticketOf(next.id)).toMatchObject({ status: 'in_progress', executionId: 'exec-1' });
    expect(await ticketOf(unsure.id)).toMatchObject({ status: 'blocked' });
  });

  it('folds a resumed run into its ticket once it completes, without touching loop memory', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    const fields = {
      loopId: loop.id,
      userId: 'user-1',
      executionId: 'exec-0',
      ...gate(new Date(1000)),
    };
    await loopEventRepository.resolveUnsure(fields, { outcome: 'resumed', by: 'user-1', at: NOW });

    executions['exec-0'] = { userId: 'user-1', status: 'running', updatedAt: NOW };
    await runLoopSchedulerTick(NOW, logger);
    expect((await eventsOf(loop.id))[0].foldedAt).toBeUndefined();

    executions['exec-0'] = { userId: 'user-1', status: 'completed', result: { answer: 'done' } };
    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'doing' });
    expect((await eventsOf(loop.id))[0].foldedAt).toBeInstanceOf(Date);
    expect(await reload(loop.id)).toMatchObject({ runCount: 0, memory: { notes: '', nextAction: '' } });
  });

  it('undoes a park that blocked the ticket after the owner had already resumed the run', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    const ticket = await createTicket(loop.id, { status: 'blocked', statusReason: 'Unsure: thin results' });
    await loopEventRepository.resolveUnsure(
      { loopId: loop.id, userId: 'user-1', executionId: 'exec-0', ...gate(new Date(1000)) },
      { outcome: 'resumed', at: NOW }
    );
    executions['exec-0'] = { userId: 'user-1', status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'doing' });
    expect((await ticketOf(ticket.id)).status).not.toBe('blocked');
  });

  it('folds a resumed run that went stale as stalled, and leaves a fresh one alone', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    await loopEventRepository.resolveUnsure(
      { loopId: loop.id, userId: 'user-1', executionId: 'exec-0', ...gate(new Date(1000)) },
      { outcome: 'resumed', at: NOW }
    );
    executions['exec-0'] = { userId: 'user-1', status: 'awaiting_subagent', updatedAt: new Date(0) };
    await runLoopSchedulerTick(NOW, logger);
    expect((await ticketOf(ticket.id)).status).toBe('in_progress');

    executions['exec-0'] = {
      userId: 'user-1',
      status: 'running',
      updatedAt: new Date(NOW.getTime() - STALE_ACTIVE_MS - 60_000),
    };
    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'blocked', statusReason: 'Run stalled' });
    expect((await eventsOf(loop.id))[0].foldedAt).toBeInstanceOf(Date);
    expect(await reload(loop.id)).toMatchObject({ consecutiveFailures: 0 });
  });

  it('parks a resumed run that pauses again under a new event', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    await loopEventRepository.resolveUnsure(
      { loopId: loop.id, userId: 'user-1', executionId: 'exec-0', ...gate(new Date(1000)) },
      { outcome: 'resumed', at: NOW }
    );
    executions['exec-0'] = { ...paused(new Date(2000)), pendingGate: gate(new Date(2000), 'still thin') };

    await runLoopSchedulerTick(NOW, logger);

    const [second, first] = await LoopEvent.find({ loopId: loop.id }).sort({ requestedAt: -1 });
    expect(second.toJSON()).toMatchObject({ reason: 'still thin' });
    expect(second.resolution).toBeUndefined();
    expect(first.foldedAt).toBeInstanceOf(Date);
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'blocked', statusReason: 'Unsure: still thin' });
  });

  it('treats a run stopped at the gate before a tick parked it as a rejected unsure, not a success', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    executions['exec-0'] = {
      userId: 'user-1',
      status: 'completed',
      result: { answer: 'partial', stoppedByGate: true },
      gateHistory: [{ ...gate(new Date(1000)), resolution: 'rejected', resolvedAt: NOW, resolvedBy: 'user-1' }],
    };

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({
      status: 'blocked',
      stage: 'todo',
      statusReason: 'Unsure: thin results',
    });
    const after = await reload(loop.id);
    expect(after).toMatchObject({ runCount: 0, consecutiveFailures: 0, memory: { notes: '' } });
    expect(after.activeExecutionId).toBeUndefined();
    const events = await eventsOf(loop.id);
    expect(events).toHaveLength(1);
    expect(events[0].resolution).toMatchObject({ outcome: 'rejected', by: 'user-1', at: NOW });
  });
});

describe('runLoopSchedulerTick - budget and auto-resume', () => {
  const MIDNIGHT = new Date('2026-10-30T00:00:00Z');
  let spentToday: number;
  let balance: { currentCredits: number } | null;

  beforeEach(() => {
    spentToday = 0;
    balance = { currentCredits: 0 };
    vi.spyOn(agentExecutionRepository, 'sumCreditsByLoop').mockImplementation((async (ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, spentToday]))) as never);
    vi.spyOn(userRepository, 'findById').mockImplementation((async () => balance) as never);
  });

  const eventsOf = (loopId: string) => LoopEvent.find({ loopId }).lean();
  const openNotices = () => Inbox.find({ deletedAt: null }).lean();

  it('does not start a run once spend today reaches the budget, and pauses until the next UTC midnight', async () => {
    const loop = await createLoop({ budgetCreditsPerDay: 10 });
    const ticket = await WorkItem.create({
      userId: 'user-1',
      loopId: loop.id,
      title: 'Write the summary',
      stage: 'todo',
      status: 'open',
      dependencies: [],
    });
    spentToday = 10;

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(agentExecutionRepository.sumCreditsByLoop).toHaveBeenCalledWith(
      [loop.id],
      ['session-1'],
      new Date('2026-10-29T00:00:00Z')
    );
    const after = await reload(loop.id);
    expect(after).toMatchObject({
      status: 'paused',
      autoResume: 'budget',
      statusReason: BUDGET_PAUSE_REASON,
      nextRunAt: MIDNIGHT,
    });
    expect(after.leaseUntil).toBeUndefined();
    expect((await WorkItem.findById(ticket.id))!.toJSON()).toMatchObject({ status: 'open' });
  });

  it('dispatches while under budget, and skips the spend check without one', async () => {
    const budgeted = await createLoop({ budgetCreditsPerDay: 10 });
    await createLoop({ sessionId: 'session-2' });
    spentToday = 9.5;

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(2);
    expect(agentExecutionRepository.sumCreditsByLoop).toHaveBeenCalledTimes(1);
    expect(agentExecutionRepository.sumCreditsByLoop).toHaveBeenCalledWith(
      [budgeted.id],
      expect.anything(),
      expect.anything()
    );
  });

  it('resumes a budget pause at the next UTC midnight and dispatches it in the same tick', async () => {
    const loop = await createLoop({ budgetCreditsPerDay: 10, lastExecutionId: 'exec-0' });
    spentToday = 10;
    await runLoopSchedulerTick(NOW, logger);
    expect(await eventsOf(loop.id)).toHaveLength(0);
    expect(await openNotices()).toHaveLength(1);

    await runLoopSchedulerTick(new Date(MIDNIGHT.getTime() - 1), logger);
    expect((await reload(loop.id)).status).toBe('paused');

    spentToday = 0;
    await runLoopSchedulerTick(MIDNIGHT, logger);

    const after = await reload(loop.id);
    expect(after).toMatchObject({ status: 'live', activeExecutionId: 'exec-1' });
    expect(after.autoResume).toBeUndefined();
    expect(after.statusReason).toBeUndefined();
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(await eventsOf(loop.id)).toMatchObject([
      { kind: 'auto_resumed', executionId: 'exec-0', reason: 'Daily budget reset', requestedAt: MIDNIGHT },
    ]);
    expect(await openNotices()).toHaveLength(0);
  });

  it('keeps a credit pause while the balance is empty and resumes once it is positive', async () => {
    const loop = await createLoop({ activeExecutionId: 'exec-0', lastExecutionId: 'exec-0' });
    executions['exec-0'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };
    await runLoopSchedulerTick(NOW, logger);

    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'paused', autoResume: 'credits' });
    expect(await openNotices()).toHaveLength(1);

    balance = { currentCredits: 5 };
    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ status: 'live', activeExecutionId: 'exec-1' });
    expect(await eventsOf(loop.id)).toMatchObject([{ kind: 'auto_resumed', reason: 'Credits available again' }]);
    expect(await openNotices()).toHaveLength(0);
  });

  it('keeps a credit pause until the balance covers one iteration of the loop model when credits are enforced', async () => {
    vi.mocked(adminSettingsRepository.getSettingsValue).mockImplementation(
      (async (key: string) => key === 'EnableLoops' || key === 'enforceCredits') as never
    );
    const model = { id: 'claude-sonnet-5' };
    h.getAvailableModels.mockResolvedValue([model]);
    h.nextIterationCredits.mockReturnValue(20);
    balance = { currentCredits: 5 };
    const loop = await createLoop({ status: 'paused', autoResume: 'credits' });

    await runLoopSchedulerTick(NOW, logger);
    expect((await reload(loop.id)).status).toBe('paused');
    expect(h.nextIterationCredits).toHaveBeenCalledWith(model, 0);

    balance = { currentCredits: 20 };
    await runLoopSchedulerTick(NOW, logger);
    expect((await reload(loop.id)).status).toBe('live');
  });

  it('keeps a credit pause on an org loop while the member is at its cap', async () => {
    // A member cap of 0 means the member is at it with nothing used.
    const org: Record<string, unknown> = { currentCredits: 100, maxCreditsPerMember: 0, userDetails: [] };
    vi.spyOn(organizationRepository, 'findById').mockResolvedValue(org as never);
    const loop = await createLoop({ status: 'paused', autoResume: 'credits', organizationId: 'org-1' });

    await runLoopSchedulerTick(NOW, logger);
    expect((await reload(loop.id)).status).toBe('paused');
    expect(organizationRepository.findById).toHaveBeenCalledWith('org-1');
    expect(userRepository.findById).not.toHaveBeenCalled();

    delete org.maxCreditsPerMember;
    await runLoopSchedulerTick(NOW, logger);
    expect((await reload(loop.id)).status).toBe('live');
  });

  it('keeps an owner pause made during a run that is then refused for credits', async () => {
    balance = { currentCredits: 100 };
    const loop = await createLoop({ status: 'paused', activeExecutionId: 'exec-0', lastExecutionId: 'exec-0' });
    executions['exec-0'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);
    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after.status).toBe('paused');
    expect(after.autoResume).toBeUndefined();
    expect(after.activeExecutionId).toBeUndefined();
  });

  it('starts no run and keeps the owner pause when it lands before the budget pause is written', async () => {
    const loop = await createLoop({ budgetCreditsPerDay: 10 });
    spentToday = 10;
    vi.mocked(agentExecutionRepository.sumCreditsByLoop).mockImplementationOnce((async () => {
      await Loop.updateOne({ _id: loop.id }, { $set: { status: 'paused' } });
      return { [loop.id]: spentToday };
    }) as never);

    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(after.status).toBe('paused');
    expect(after.autoResume).toBeUndefined();
    expect(after.leaseUntil).toBeUndefined();
  });

  it('keeps a credit pause when the billing account is gone', async () => {
    balance = null;
    const loop = await createLoop({ status: 'paused', autoResume: 'credits' });

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).status).toBe('paused');
  });

  it('treats a legacy budget of 0 as no budget', async () => {
    const loop = await createLoop();
    // Stored before the > 0 validator; updateOne skips validators.
    await Loop.updateOne({ _id: loop.id }, { $set: { budgetCreditsPerDay: 0 } });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(agentExecutionRepository.sumCreditsByLoop).not.toHaveBeenCalled();
  });

  it('resumes a budget pause with no last run without logging an event', async () => {
    const loop = await createLoop({ status: 'paused', autoResume: 'budget', statusReason: BUDGET_PAUSE_REASON });
    vi.mocked(logger.error).mockClear();

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).status).toBe('live');
    expect(await eventsOf(loop.id)).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('never resumes an owner pause', async () => {
    balance = { currentCredits: 100 };
    const loop = await createLoop({ status: 'paused' });

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).status).toBe('paused');
    expect(h.startAgentExecution).not.toHaveBeenCalled();
  });
});
