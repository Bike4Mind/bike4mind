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
  loopDirectiveRepository,
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
  pushLoopChanged: vi.fn(),
}));
vi.mock('@server/utils/loopDispatch', () => ({ pushLoopChanged: h.pushLoopChanged, requestLoopDispatch: vi.fn() }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution: h.startAgentExecution }));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: h.getAvailableModels,
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  nextIterationCredits: h.nextIterationCredits,
}));

import {
  BUDGET_PAUSE_REASON,
  dispatchLoopNow,
  LOOP_LEASE_MS,
  MAX_CONSECUTIVE_FAILURES,
  runLoopSchedulerTick,
  USER_BUDGET_PAUSE_REASON,
} from './loopScheduler';

/** The default LoopsMaxActiveRuns. */
const MAX_ACTIVE_LOOP_RUNS = 4;
import { STALE_ACTIVE_MS } from '@server/utils/executionLimits';
import { makeDueIfReady } from '@server/utils/loopTickets';
import { buildLoopQuery } from '@server/utils/loopMemory';

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
  // A funded owner and an unpriceable model by default, so admission passes unless a test says otherwise.
  vi.spyOn(userRepository, 'findById').mockResolvedValue({ currentCredits: 1000 } as never);
  h.getAvailableModels.mockResolvedValue([]);
  let n = 0;
  h.startAgentExecution.mockImplementation(async () => ({ ok: true, executionId: `exec-${++n}` }));
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.restoreAllMocks();
  h.startAgentExecution.mockReset();
  h.getAvailableModels.mockReset();
  h.nextIterationCredits.mockReset();
  h.pushLoopChanged.mockReset();
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
    expect(after).toMatchObject({ lastExecutionId: 'exec-1', activeExecutionIds: ['exec-1'] });
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
    await createLoop({ activeExecutionIds: ['exec-0'], leaseUntil: PAST });
    executions['exec-0'] = { status: 'running', updatedAt: NOW };

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
  });

  it('pauses the loop when its run was refused for credits', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: new Date(NOW.getTime() + 60_000) });
    executions['exec-0'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after).toMatchObject({ status: 'paused', statusReason: 'Out of credits', autoResume: 'credits' });
    expect(after.activeExecutionIds ?? []).toEqual([]);
  });

  it('keeps a failing loop live until the failure limit, then moves it to error', async () => {
    const loop = await createLoop({
      activeExecutionIds: ['exec-0'],
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 2,
      nextRunAt: new Date(NOW.getTime() + 60_000),
    });
    executions['exec-0'] = { status: 'failed', error: { message: 'LLM API returned 500', callerSafe: true } };
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'live', statusReason: 'LLM API returned 500' });

    await Loop.updateOne({ _id: loop.id }, { $set: { activeExecutionIds: ['exec-00'] } });
    executions['exec-00'] = { status: 'aborted' };
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'error', statusReason: 'Run aborted' });
  });

  it('never shows the owner a raw executor error', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: new Date(NOW.getTime() + 60_000) });
    executions['exec-0'] = {
      status: 'failed',
      error: { message: 'connect ECONNREFUSED internal-db.cluster.local:27017' },
    };

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).statusReason).toBe('Agent execution failed');
  });

  it('records a run whose execution doc is gone as a failure', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: new Date(NOW.getTime() + 60_000) });
    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ statusReason: 'Run not found', consecutiveFailures: 1 });
  });

  it('does not move a loop the owner paused to error', async () => {
    const loop = await createLoop({
      status: 'paused',
      activeExecutionIds: ['exec-0'],
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
    });
    executions['exec-0'] = { status: 'aborted' };

    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ status: 'paused', consecutiveFailures: MAX_CONSECUTIVE_FAILURES });
  });

  it('never stale-folds a run that is waiting on its children', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'] });
    executions['exec-0'] = { status: 'awaiting_subagent', updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000) };

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).activeExecutionIds).toEqual(['exec-0']);
    expect(h.startAgentExecution).not.toHaveBeenCalled();
  });

  it('folds a run that went quiet past the stale threshold as a failure', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: new Date(NOW.getTime() + 60_000) });
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
    expect(after.hold).toMatchObject({ kind: 'capacity', limit: 'user' });
  });

  it('does not let a loop that could not start block the other due loops', async () => {
    const stuck = await createLoop({ nextRunAt: new Date(PAST.getTime() - 60_000) });
    const other = await createLoop({ userId: 'user-2' });
    h.startAgentExecution.mockResolvedValueOnce({ ok: false, reason: 'dispatch_failed', message: 'invoke failed' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution.mock.calls.map(([input]) => input.userId)).toEqual(['user-1', 'user-2']);
    expect((await reload(stuck.id)).leaseUntil).toBeUndefined();
    expect((await reload(other.id)).activeExecutionIds).toEqual(['exec-1']);
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
    expect(after).toMatchObject({ activeExecutionIds: ['exec-7'], lastExecutionId: 'exec-7' });
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
    vi.spyOn(workItemRepository, 'listReadyForLoop').mockRejectedValue(new Error('db down'));

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect((await reload(loop.id)).leaseUntil).toBeUndefined();
  });

  it('releases the lease when loading directives throws', async () => {
    const loop = await createLoop();
    vi.spyOn(loopDirectiveRepository, 'listOpenForLoop').mockRejectedValue(new Error('db down'));

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
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: new Date(NOW.getTime() + 60_000) });
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
        priority: 'p2',
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
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
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
    const failing = await createLoop({ activeExecutionIds: ['exec-f'], nextRunAt: LATER });
    const blocked = await createTicket(failing.id, { status: 'in_progress', executionId: 'exec-f' });
    executions['exec-f'] = { status: 'aborted' };
    const broke = await createLoop({ activeExecutionIds: ['exec-c'], nextRunAt: LATER });
    const reopened = await createTicket(broke.id, { status: 'in_progress', executionId: 'exec-c' });
    executions['exec-c'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(blocked.id)).toMatchObject({ status: 'blocked', statusReason: 'Run aborted' });
    expect(await ticketOf(reopened.id)).toMatchObject({ status: 'open', stage: 'todo' });
    expect(await reload(broke.id)).toMatchObject({ status: 'paused' });
  });

  it('respects a ticket the run blocked itself', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
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
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0' });
    const next = await createTicket(loop.id, { title: 'Next one' });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);

    // The folded ticket (now in "doing") and the next one are both ready; the older one goes first.
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0].query).not.toContain(next.id);

    const quiet = await createLoop({ activeExecutionIds: ['exec-q'], nextRunAt: LATER });
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
    expect(after.runCount).toBe(0);
  });

  it('reopens a ticket parked on a dependency that closed, and runs it in the same tick', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    const dep = await createTicket(loop.id, { stage: 'done', status: 'closed', closedAt: PAST });
    const parked = await createTicket(loop.id, {
      status: 'blocked',
      blockedOn: 'dependencies',
      statusReason: 'Waiting on dependencies',
      dependencies: [dep.id],
      runCount: 1,
    });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0].query).toContain(`Ticket id: ${parked.id}`);
    const after = await ticketOf(parked.id);
    // The claim counts this run on top of the earlier one: a reopen is not an owner move.
    expect(after).toMatchObject({ status: 'in_progress', executionId: 'exec-1', runCount: 2 });
    expect(after.blockedOn).toBeUndefined();
  });

  it('claims a p0 ticket before an older p2 one', async () => {
    const loop = await createLoop();
    await createTicket(loop.id, { title: 'Older', priority: 'p2' });
    const urgent = await createTicket(loop.id, { title: 'Urgent', priority: 'p0' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution.mock.calls[0][0].query).toContain(`Ticket id: ${urgent.id}`);
  });

  it('never reopens an unsure or run-limit block, even with every dependency closed', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    const dep = await createTicket(loop.id, { stage: 'done', status: 'closed', closedAt: PAST });
    const held = await Promise.all(
      ['Unsure: which repo?', 'Ran 6 times without finishing'].map(statusReason =>
        createTicket(loop.id, { status: 'blocked', statusReason, dependencies: [dep.id] })
      )
    );

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    for (const ticket of held) expect(await ticketOf(ticket.id)).toMatchObject({ status: 'blocked' });
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
        priority: 'p2',
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
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    executions['exec-0'] = paused();

    await runLoopSchedulerTick(NOW, logger);
    await Loop.updateOne({ _id: loop.id }, { $set: { activeExecutionIds: ['exec-0'] } });
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
    expect(after.activeExecutionIds ?? []).toEqual([]);
    expect(after.statusReason).toBeUndefined();
  });

  it('never folds a gate-paused run as stalled', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    const ticket = await createTicket(loop.id);
    executions['exec-0'] = paused(new Date(1000), new Date(NOW.getTime() - STALE_ACTIVE_MS - 60_000));

    await runLoopSchedulerTick(NOW, logger);

    expect((await ticketOf(ticket.id)).statusReason).toBe('Unsure: thin results');
    expect(await reload(loop.id)).toMatchObject({ consecutiveFailures: 0, status: 'live' });
  });

  it("works the loop's next ready ticket while the unsure one stays blocked", async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
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
    h.pushLoopChanged.mockClear();
    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'doing' });
    expect((await eventsOf(loop.id))[0].foldedAt).toBeInstanceOf(Date);
    // The fold's own push, before the dispatch the advanced ticket triggers.
    expect(h.pushLoopChanged.mock.invocationCallOrder[0]).toBeLessThan(
      h.startAgentExecution.mock.invocationCallOrder[0] ?? Infinity
    );
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

  it('leaves a ticket the run parked with loop_ticket_unsure blocked, and never folds the answered ask', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    const ticket = await createTicket(loop.id, { status: 'blocked', statusReason: 'Unsure: EU or US?' });
    await loopEventRepository.recordUnsure({
      source: 'asked',
      loopId: loop.id,
      userId: 'user-1',
      executionId: 'exec-0',
      workItemId: ticket.id,
      ticketTitle: 'Research X',
      reason: 'EU or US?',
      requestedAt: new Date(1000),
    });
    executions['exec-0'] = { userId: 'user-1', status: 'completed', result: { answer: 'asked' } };

    await runLoopSchedulerTick(NOW, logger);
    expect(await ticketOf(ticket.id)).toMatchObject({
      status: 'blocked',
      statusReason: 'Unsure: EU or US?',
      stage: 'todo',
    });

    // The owner answers: these three writes mirror the resolve route (apps/client, tested there), and the next
    // run is shown the answer.
    const [asked] = await eventsOf(loop.id);
    await loopEventRepository.resolveAsked(asked.id, 'user-1', loop.id, { outcome: 'resumed', at: NOW, note: 'EU' });
    await workItemRepository.updateForUser(ticket.id, 'user-1', { status: 'open', statusReason: null }, 'blocked');
    await loopRepository.makeDueNow(loop.id, NOW);
    h.startAgentExecution.mockClear();

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0].query).toContain('Owner answered your question "EU or US?": "EU"');
    // Folding the answered ask would advance the ticket past the stage the owner just answered for.
    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'todo', status: 'in_progress' });
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
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
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
    expect(after.activeExecutionIds ?? []).toEqual([]);
    const events = await eventsOf(loop.id);
    expect(events).toHaveLength(1);
    expect(events[0].resolution).toMatchObject({ outcome: 'rejected', by: 'user-1', at: NOW });
  });
});

describe('runLoopSchedulerTick - directives', () => {
  it("shows a run its loop's open and accepted directives, and the loops it oversees", async () => {
    const worker = await createLoop({ nextRunAt: new Date(NOW.getTime() + 60_000) });
    const overseer = await createLoop({
      name: 'Lead',
      oversees: [worker.id],
      nextRunAt: new Date(NOW.getTime() + 60_000),
    });
    const directive = (instruction: string, state: string, replies: unknown[] = []) =>
      loopDirectiveRepository.create({
        loopId: worker.id,
        userId: 'user-1',
        fromLoopId: overseer.id,
        fromLoopName: 'Lead',
        executionId: 'exec-lead',
        instruction,
        reason: 'because',
        state,
        replies,
      } as never);
    await directive('open one', 'open');
    await directive('accepted one', 'accepted');
    await directive('finished one', 'done');
    await directive('withdrawn one', 'withdrawn');
    const insisted = await directive('insisted one', 'open', [
      { by: 'worker', outcome: 'pushed_back', note: 'no', executionId: 'x', at: PAST },
      { by: 'owner', outcome: 'overruled', userId: 'user-1', at: PAST },
    ]);

    await Loop.updateOne({ _id: worker.id }, { $set: { nextRunAt: PAST } });
    await runLoopSchedulerTick(NOW, logger);
    const workerQuery: string = h.startAgentExecution.mock.calls[0][0].query;
    expect(workerQuery).toContain('"open one"');
    expect(workerQuery).toContain('"accepted one"');
    expect(workerQuery).not.toContain('finished one');
    expect(workerQuery).not.toContain('withdrawn one');
    expect(workerQuery).toContain(`Directive id: ${insisted.id} (owner insists)`);
    expect(workerQuery).not.toContain('You oversee');

    await Loop.updateOne({ _id: overseer.id }, { $set: { nextRunAt: PAST } });
    await runLoopSchedulerTick(NOW, logger);
    const overseerQuery: string = h.startAgentExecution.mock.calls[1][0].query;
    expect(overseerQuery).toContain(`You oversee these loops: "Digest" (${worker.id}).`);
    expect(overseerQuery).not.toContain('Directives from loops');
  });
});

describe('runLoopSchedulerTick - budget and auto-resume', () => {
  const MIDNIGHT = new Date('2026-10-30T00:00:00Z');
  let spentToday: number;
  let balance: { currentCredits: number } | null;

  beforeEach(() => {
    spentToday = 0;
    balance = { currentCredits: 100 };
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
      priority: 'p2',
    });
    spentToday = 10;

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(agentExecutionRepository.sumCreditsByLoop).toHaveBeenCalledWith(
      [loop.id],
      ['session-1'],
      new Date('2026-10-29T00:00:00Z'),
      true
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

  it('dispatches while under its paced budget, and skips the spend check without one', async () => {
    const budgeted = await createLoop({ budgetCreditsPerDay: 10 });
    await createLoop({ sessionId: 'session-2' });
    // At 12:00 UTC the paced allowance is 10 * 13/24 = 5.42.
    spentToday = 5;

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(2);
    expect(agentExecutionRepository.sumCreditsByLoop).toHaveBeenCalledTimes(1);
    expect(agentExecutionRepository.sumCreditsByLoop).toHaveBeenCalledWith(
      [budgeted.id],
      expect.anything(),
      expect.anything(),
      true
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
    expect(after).toMatchObject({ status: 'live', activeExecutionIds: ['exec-1'] });
    expect(after.autoResume).toBeUndefined();
    expect(after.statusReason).toBeUndefined();
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(await eventsOf(loop.id)).toMatchObject([
      { kind: 'auto_resumed', executionId: 'exec-0', reason: 'Daily budget reset', requestedAt: MIDNIGHT },
    ]);
    expect(await openNotices()).toHaveLength(0);
  });

  it('keeps a credit pause while the balance is empty and resumes once it is positive', async () => {
    balance = { currentCredits: 0 };
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], lastExecutionId: 'exec-0' });
    executions['exec-0'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };
    await runLoopSchedulerTick(NOW, logger);

    await runLoopSchedulerTick(NOW, logger);
    expect(await reload(loop.id)).toMatchObject({ status: 'paused', autoResume: 'credits' });
    expect(await openNotices()).toHaveLength(1);

    balance = { currentCredits: 5 };
    h.pushLoopChanged.mockClear();
    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ status: 'live', activeExecutionIds: ['exec-1'] });
    // The resume's own push, before the dispatch's.
    expect(h.pushLoopChanged.mock.invocationCallOrder[0]).toBeLessThan(
      h.startAgentExecution.mock.invocationCallOrder[0]
    );
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
    const loop = await createLoop({ status: 'paused', activeExecutionIds: ['exec-0'], lastExecutionId: 'exec-0' });
    executions['exec-0'] = { status: 'failed', failureReason: 'insufficient_credits', error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);
    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after.status).toBe('paused');
    expect(after.autoResume).toBeUndefined();
    expect(after.activeExecutionIds ?? []).toEqual([]);
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

describe('runLoopSchedulerTick - stage config', () => {
  const STAGES = ['todo', 'review', 'done'];
  const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
    (
      await WorkItem.create({
        userId: 'user-1',
        loopId,
        title: 'Write the summary',
        stage: 'todo',
        status: 'open',
        dependencies: [],
        priority: 'p2',
        ...overrides,
      })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const LATER = new Date(NOW.getTime() + 60 * 60_000);

  it('dispatches a loop without stageConfig with its own model, tools and an unchanged query', async () => {
    const loop = await createLoop({ stages: STAGES });
    const ticket = await createTicket(loop.id);

    await runLoopSchedulerTick(NOW, logger);

    const input = h.startAgentExecution.mock.calls[0][0];
    expect(input.model).toBe('claude-sonnet-5');
    expect(input.enabledTools).toEqual(['web_search', 'mcp__srv__do_thing']);
    expect(input.query).toBe(
      buildLoopQuery(
        loop.goal,
        loop.memory,
        { item: { ...ticket, stage: 'todo' }, stages: STAGES },
        {
          directives: [],
          overseen: [],
        }
      )
    );
    expect(input.query).not.toContain('Instructions for the');
  });

  it("applies the ticket's stage model, tools and instructions, and the loop defaults elsewhere", async () => {
    const stageConfig = [{ stage: 'review', model: 'm2', tools: ['web_search'], instructions: 'Review only' }];
    const reviewing = await createLoop({ stages: STAGES, stageConfig });
    await createTicket(reviewing.id, { stage: 'review' });
    const todo = await createLoop({ stages: STAGES, stageConfig });
    await createTicket(todo.id, { stage: 'todo' });

    await runLoopSchedulerTick(NOW, logger);

    const byLoop = Object.fromEntries(h.startAgentExecution.mock.calls.map(([input]) => [input.loopId, input]));
    expect(byLoop[reviewing.id]).toMatchObject({ model: 'm2', enabledTools: ['web_search'] });
    const query: string = byLoop[reviewing.id].query;
    expect(query).toContain('Instructions for the "review" stage:\nReview only');
    expect(query.indexOf('Review only')).toBeLessThan(query.indexOf('---'));
    expect(byLoop[todo.id]).toMatchObject({
      model: 'claude-sonnet-5',
      enabledTools: ['web_search', 'mcp__srv__do_thing'],
    });
    expect(byLoop[todo.id].query).not.toContain('Instructions for the');
  });

  it("prices admission on the ticket's stage model and leaves the ticket unclaimed when it does not admit", async () => {
    const claim = vi.spyOn(workItemRepository, 'claimForRun');
    h.getAvailableModels.mockResolvedValue([{ id: 'claude-sonnet-5' }, { id: 'm2' }]);
    h.nextIterationCredits.mockImplementation((model: { id: string }) => (model.id === 'm2' ? 20 : 5));
    const stageConfig = [{ stage: 'review', model: 'm2' }];
    const pricey = await createLoop({ stages: STAGES, stageConfig, budgetCreditsPerDay: 10 });
    const ticket = await createTicket(pricey.id, { stage: 'review' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(await reload(pricey.id)).toMatchObject({ status: 'paused', statusReason: BUDGET_PAUSE_REASON });
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open', runCount: 0 });
    expect(claim).not.toHaveBeenCalled();

    const cheap = await createLoop({
      stages: STAGES,
      stageConfig: [{ stage: 'review', model: 'claude-sonnet-5' }],
      model: 'm2',
      budgetCreditsPerDay: 10,
      sessionId: 'session-2',
    });
    await createTicket(cheap.id, { stage: 'review' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5', loopId: cheap.id });
    expect(h.startAgentExecution.mock.calls[0][0].creditCap).toBeGreaterThan(0);
  });

  it("keeps a credit pause until the balance covers the next ticket's stage model", async () => {
    vi.mocked(adminSettingsRepository.getSettingsValue).mockImplementation(
      (async (key: string) => key === 'EnableLoops' || key === 'enforceCredits') as never
    );
    h.getAvailableModels.mockResolvedValue([{ id: 'claude-sonnet-5' }, { id: 'm2' }]);
    h.nextIterationCredits.mockImplementation((model: { id: string }) => (model.id === 'm2' ? 20 : 5));
    vi.mocked(userRepository.findById).mockResolvedValue({ currentCredits: 10 } as never);
    const loop = await createLoop({
      stages: STAGES,
      stageConfig: [{ stage: 'review', model: 'm2' }],
      status: 'paused',
      autoResume: 'credits',
      lastExecutionId: 'exec-0',
    });
    await createTicket(loop.id, { stage: 'review' });

    await runLoopSchedulerTick(NOW, logger);
    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({ status: 'paused', autoResume: 'credits' });
    expect(await LoopEvent.find({ loopId: loop.id }).lean()).toHaveLength(0);
    expect(h.startAgentExecution).not.toHaveBeenCalled();

    vi.mocked(userRepository.findById).mockResolvedValue({ currentCredits: 20 } as never);
    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({ model: 'm2', loopId: loop.id });
  });

  it('keeps the loop tools for a stage that sets only a model', async () => {
    const loop = await createLoop({ stages: STAGES, stageConfig: [{ stage: 'review', model: 'm2' }] });
    await createTicket(loop.id, { stage: 'review' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({
      model: 'm2',
      enabledTools: ['web_search', 'mcp__srv__do_thing'],
    });
  });

  it('first releases desktop runs whose lease lapsed, reopening their tickets, and leaves a fresh one', async () => {
    const loop = await createLoop({
      stages: STAGES,
      stageConfig: [{ stage: 'review', runner: 'desktop' }],
      nextRunAt: new Date(NOW.getTime() + 60 * 60_000),
    });
    const AgentExecution = mongoose.model('AgentExecution');
    const desktopRun = async (leaseUntil: Date) => {
      const id = new mongoose.Types.ObjectId().toString();
      const ticket = await createTicket(loop.id, {
        stage: 'review',
        status: 'in_progress',
        executionId: id,
        runCount: 1,
      });
      await AgentExecution.create({
        _id: id,
        userId: 'user-1',
        sessionId: 'session-1',
        questId: 'session-1',
        query: 'q',
        model: 'm',
        status: 'running',
        loopId: loop.id,
        runner: 'desktop',
        runnerLeaseUntil: leaseUntil,
      });
      return { id, ticket };
    };
    const lapsed = await desktopRun(new Date(NOW.getTime() - 1000));
    const fresh = await desktopRun(new Date(NOW.getTime() + 60_000));
    vi.mocked(agentExecutionRepository.findById).mockRestore();

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(lapsed.ticket.id)).toMatchObject({ status: 'open', runCount: 1 });
    expect((await AgentExecution.findById(lapsed.id))!.toObject()).toMatchObject({
      status: 'failed',
      failureReason: 'abandoned',
    });
    expect(await ticketOf(fresh.ticket.id)).toMatchObject({ status: 'in_progress' });
    expect((await AgentExecution.findById(fresh.id))!.toObject()).toMatchObject({ status: 'running' });
    expect(h.startAgentExecution).not.toHaveBeenCalled();
  });

  it('never claims a desktop-stage ticket: an older one is skipped for a newer cloud one', async () => {
    const loop = await createLoop({ stages: STAGES, stageConfig: [{ stage: 'review', runner: 'desktop' }] });
    const desktop = await createTicket(loop.id, { stage: 'review' });
    const cloud = await createTicket(loop.id, { stage: 'todo' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution.mock.calls[0][0].query).toContain(`Ticket id: ${cloud.id}`);
    expect(await ticketOf(desktop.id)).toMatchObject({ status: 'open' });
  });

  it('runs a plain goal run when only desktop tickets are ready, without making the loop due for them', async () => {
    const loop = await createLoop({ stages: STAGES, stageConfig: [{ stage: 'review', runner: 'desktop' }] });
    const desktop = await createTicket(loop.id, { stage: 'review' });

    await runLoopSchedulerTick(NOW, logger);

    const { query } = h.startAgentExecution.mock.calls[0][0];
    expect(query).not.toContain('Ticket id:');
    expect(query).toContain(`Tickets in the "review" stage(s) are worked by the\nowner's desktop app`);
    expect(await ticketOf(desktop.id)).toMatchObject({ status: 'open' });

    const live = await createLoop({
      stages: STAGES,
      stageConfig: [{ stage: 'review', runner: 'desktop' }],
      nextRunAt: LATER,
    });
    await createTicket(live.id, { stage: 'review' });
    await makeDueIfReady(live, NOW);
    expect((await reload(live.id)).nextRunAt).toEqual(LATER);
  });

  it('leaves a ticket advanced into a desktop stage open there, unclaimed on the next tick', async () => {
    const loop = await createLoop({
      stages: STAGES,
      stageConfig: [{ stage: 'review', runner: 'desktop' }],
      activeExecutionIds: ['exec-0'],
      nextRunAt: LATER,
    });
    const ticket = await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0' });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await runLoopSchedulerTick(NOW, logger);
    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'review', status: 'open' });
    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect((await reload(loop.id)).nextRunAt).toEqual(LATER);

    await runLoopSchedulerTick(LATER, logger);
    expect(h.startAgentExecution.mock.calls[0][0].query).not.toContain('Ticket id:');
    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'review', status: 'open' });
  });
});

describe('runLoopSchedulerTick - safety and pacing', () => {
  const settings = (values: Record<string, unknown>) =>
    vi
      .mocked(adminSettingsRepository.getSettingsValue)
      .mockImplementation((async (key: string) => (key === 'EnableLoops' ? true : values[key])) as never);
  const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
    (
      await WorkItem.create({
        userId: 'user-1',
        loopId,
        title: 'Write the summary',
        stage: 'todo',
        status: 'open',
        dependencies: [],
        priority: 'p2',
        ...overrides,
      })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const running = () => ({ status: 'running', updatedAt: NOW });
  const LATER = new Date(NOW.getTime() + 60 * 60_000);

  it('dispatches no loop with 4 loop runs in flight, and at most 2 with 2 in flight', async () => {
    for (let i = 0; i < 4; i++) {
      await createLoop({ activeExecutionIds: [`busy-${i}`], nextRunAt: LATER });
      executions[`busy-${i}`] = running();
    }
    for (let i = 0; i < 5; i++) await createLoop({ userId: `due-${i}` });

    await runLoopSchedulerTick(NOW, logger);
    expect(h.startAgentExecution).not.toHaveBeenCalled();

    await Loop.updateMany(
      { activeExecutionIds: { $in: ['busy-0', 'busy-1'] } },
      { $unset: { activeExecutionIds: '' } }
    );
    await runLoopSchedulerTick(NOW, logger);
    expect(h.startAgentExecution).toHaveBeenCalledTimes(2);
  });

  it("does not let one user's many due loops keep another user's loop out of the tick", async () => {
    await Loop.insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        userId: 'user-a',
        name: `A${i}`,
        goal: 'g',
        model: 'claude-sonnet-5',
        sessionId: `sa-${i}`,
        intervalMinutes: 15,
        status: 'live',
        nextRunAt: new Date(PAST.getTime() - (i + 1) * 60_000),
      }))
    );
    await createLoop({ userId: 'user-b' });

    await runLoopSchedulerTick(NOW, logger);

    // user-a stops at its 2 cloud lanes (LoopsCloudLanesPerUser default), well under the 4 server-wide.
    const users = h.startAgentExecution.mock.calls.map(call => call[0].userId);
    expect(users.sort()).toEqual(['user-a', 'user-a', 'user-b']);
  });

  it('pauses a loop whose payer cannot cover one iteration, without creating an execution', async () => {
    vi.mocked(userRepository.findById).mockResolvedValue({ currentCredits: 0 } as never);
    const loop = await createLoop();

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(await reload(loop.id)).toMatchObject({
      status: 'paused',
      autoResume: 'credits',
      statusReason: 'Out of credits',
    });
  });

  it('passes the run the lowest of the remaining loop, paced and all-loops budgets as its credit cap', async () => {
    settings({ LoopsDailyCreditsPerUser: 100 });
    vi.spyOn(agentExecutionRepository, 'sumCreditsByLoop').mockImplementation((async (ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, 5]))) as never);
    vi.spyOn(agentExecutionRepository, 'sumLoopCreditsForUser').mockResolvedValue(50);
    await createLoop({ budgetCreditsPerDay: 24 });

    await runLoopSchedulerTick(NOW, logger);

    // At 12:00 the all-loops allowance is 100 * 13/24 = 54.17, of which 50 is spent.
    expect(h.startAgentExecution.mock.calls[0][0].creditCap).toBeCloseTo(100 * (13 / 24) - 50);
  });

  it("reserves in-flight capped runs at their cap, so a third dispatch only gets what's left", async () => {
    settings({ LoopsDailyCreditsPerUser: 100 });
    for (const id of ['exec-a', 'exec-b']) {
      await agentExecutionRepository.create({
        userId: 'user-1',
        sessionId: 'session-x',
        questId: 'quest-x',
        loopId: `loop-${id}`,
        query: 'q',
        model: 'claude-sonnet-5',
        status: 'running',
        approvedTools: [],
        deniedTools: [],
        iterationBilling: [],
        totalCreditsUsed: 1,
        creditCap: 20,
        lambdaInvocationCount: 1,
        childExecutionIds: [],
        createdAt: NOW,
      } as never);
      executions[id] = { status: 'running', updatedAt: NOW };
      // Another owner's loops hold the lanes, so user-1's lane cap does not apply; the runs still bill user-1.
      await createLoop({ userId: 'user-2', activeExecutionIds: [id], nextRunAt: new Date(NOW.getTime() + 3_600_000) });
    }
    await createLoop();

    await runLoopSchedulerTick(NOW, logger);

    // At 12:00 the all-loops allowance is 100 * 13/24 = 54.17; the two runs in flight reserve 20 each.
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0].creditCap).toBeCloseTo(100 * (13 / 24) - 40);
  });

  it('starts an uncapped run when no budget is set', async () => {
    await createLoop();
    await runLoopSchedulerTick(NOW, logger);
    expect(h.startAgentExecution.mock.calls[0][0]).not.toHaveProperty('creditCap');
  });

  it('defers a loop that is ahead of its paced budget, and runs it once the allowance covers an iteration', async () => {
    vi.spyOn(agentExecutionRepository, 'sumCreditsByLoop').mockImplementation((async (ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, 5]))) as never);
    const early = new Date('2026-10-29T02:30:00Z');
    const loop = await createLoop({ budgetCreditsPerDay: 24, nextRunAt: early });

    // Allowance at 02:30 is 24 * 3.5/24 = 3.5, under the 5 already spent.
    await runLoopSchedulerTick(early, logger);

    const deferred = await reload(loop.id);
    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(deferred.status).toBe('live');
    expect(deferred.leaseUntil).toBeUndefined();
    expect(deferred.nextRunAt!.getTime()).toBeGreaterThan(new Date('2026-10-29T04:00:00Z').getTime());
    expect(await Inbox.countDocuments({})).toBe(0);

    await runLoopSchedulerTick(deferred.nextRunAt!, logger);
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
  });

  it('pauses rather than defers when the budget left cannot cover one iteration', async () => {
    h.getAvailableModels.mockResolvedValue([{ id: 'claude-sonnet-5' }]);
    h.nextIterationCredits.mockReturnValue(20);
    const loop = await createLoop({ budgetCreditsPerDay: 10 });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(await reload(loop.id)).toMatchObject({ status: 'paused', statusReason: BUDGET_PAUSE_REASON });
  });

  it("pauses all of a user's live loops at the lower of the admin and user caps, with one notice, until midnight", async () => {
    settings({ LoopsDailyCreditsPerUser: 50 });
    vi.mocked(userRepository.findById).mockResolvedValue({ currentCredits: 1000, loopsDailyCredits: 30 } as never);
    const spent = vi.spyOn(agentExecutionRepository, 'sumLoopCreditsForUser').mockResolvedValue(30);
    const due = await createLoop();
    const waiting = await createLoop({ nextRunAt: LATER, sessionId: 'session-2' });
    const owned = await createLoop({ status: 'paused', sessionId: 'session-3' });
    const theirs = await createLoop({ userId: 'user-2', nextRunAt: LATER, sessionId: 'session-4' });

    await runLoopSchedulerTick(NOW, logger);
    await runLoopSchedulerTick(NOW, logger);

    const midnight = new Date('2026-10-30T00:00:00Z');
    expect(h.startAgentExecution).not.toHaveBeenCalled();
    for (const id of [due.id, waiting.id]) {
      expect(await reload(id)).toMatchObject({
        status: 'paused',
        autoResume: 'budget',
        statusReason: USER_BUDGET_PAUSE_REASON,
        nextRunAt: midnight,
      });
    }
    expect((await reload(owned.id)).autoResume).toBeUndefined();
    expect((await reload(theirs.id)).status).toBe('live');
    const notices = await Inbox.find({ deletedAt: null }).lean();
    expect(notices.map(notice => notice.sourceKey)).toEqual(['loop:user:user-1:budget']);

    spent.mockResolvedValue(0);
    await runLoopSchedulerTick(midnight, logger);
    expect((await reload(waiting.id)).status).toBe('live');
    expect(await Inbox.countDocuments({ deletedAt: null })).toBe(0);
  });

  it("returns a capped run's ticket to open without counting a failure, and says why on the loop", async () => {
    h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'concurrent_limit' });
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    const ticket = await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0', runCount: 1 });
    executions['exec-0'] = { status: 'failed', failureReason: 'credit_cap', creditCap: 12.5, error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);

    // Uncounted, and not made due now: the interval and pacing pick the next run.
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open', runCount: 0 });
    const after = await reload(loop.id);
    expect(after).toMatchObject({
      nextRunAt: LATER,
      status: 'live',
      consecutiveFailures: 0,
      statusReason: 'Last run stopped at its credit cap (12.5 credits)',
    });
    expect(after.activeExecutionIds ?? []).toEqual([]);
  });

  it("returns a ticket stopped by a new account's spend cap to open without counting a failure", async () => {
    h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'concurrent_limit' });
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    const ticket = await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0', runCount: 1 });
    executions['exec-0'] = { status: 'failed', failureReason: 'spend_cap', error: { message: 'x' } };

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open', runCount: 0 });
    expect(await reload(loop.id)).toMatchObject({
      nextRunAt: LATER,
      status: 'live',
      consecutiveFailures: 0,
      statusReason: "Last run stopped at the new account's spend cap",
    });
  });

  it('blocks a ticket that used up its runs and works the next one', async () => {
    const loop = await createLoop();
    const spent = await createTicket(loop.id, { title: 'Spent', runCount: 6 });
    const next = await createTicket(loop.id, { title: 'Next' });

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(spent.id)).toMatchObject({
      status: 'blocked',
      statusReason: 'Ran 6 times without finishing',
    });
    expect(await ticketOf(next.id)).toMatchObject({ status: 'in_progress', runCount: 1, executionId: 'exec-1' });
  });

  it('works a ticket further along before an older one in an earlier stage', async () => {
    const loop = await createLoop();
    await createTicket(loop.id, { title: 'Older' });
    const along = await createTicket(loop.id, { title: 'Along', stage: 'doing' });

    await runLoopSchedulerTick(NOW, logger);

    expect(await ticketOf(along.id)).toMatchObject({ status: 'in_progress' });
  });

  it('backs an idle loop off 2x per idle run up to 8x its interval, and a ticket change ends it', async () => {
    // An answer without a memory block becomes the notes, so the same answer again leaves memory unchanged.
    const loop = await createLoop({ nextRunAt: LATER, memory: { notes: 'nothing new', nextAction: '' } });
    const idleRun = async (n: number) => {
      await Loop.updateOne({ _id: loop.id }, { $set: { activeExecutionIds: [`idle-${n}`] } });
      executions[`idle-${n}`] = {
        status: 'completed',
        result: { answer: 'nothing new' },
        // Started after the last fold wrote memory, as a real next run is, so its memory replaces the loop's.
        createdAt: NOW,
        completedAt: NOW,
      };
      await runLoopSchedulerTick(NOW, logger);
      return reload(loop.id);
    };

    expect(await idleRun(1)).toMatchObject({ idleStreak: 1, nextRunAt: new Date(NOW.getTime() + 30 * 60_000) });
    expect(await idleRun(2)).toMatchObject({ idleStreak: 2, nextRunAt: new Date(NOW.getTime() + 60 * 60_000) });
    await idleRun(3);
    expect(await idleRun(4)).toMatchObject({ idleStreak: 4, nextRunAt: new Date(NOW.getTime() + 120 * 60_000) });

    await loopRepository.makeDueNow(loop.id, NOW);
    expect(await reload(loop.id)).toMatchObject({ idleStreak: 0, nextRunAt: NOW });
  });

  it('does not back off a run that a Run now, edit or directive landed during', async () => {
    const memory = { notes: 'same', nextAction: '' };
    const loop = await createLoop({ nextRunAt: NOW, memory, activeExecutionIds: ['reset-mid-run'], idleResetAt: NOW });
    executions['reset-mid-run'] = {
      status: 'completed',
      result: { answer: 'same' },
      createdAt: PAST,
      completedAt: NOW,
    };

    await runLoopSchedulerTick(NOW, logger);

    expect((await reload(loop.id)).idleStreak).toBe(0);
  });

  it('does not back off a run that changed memory or touched a ticket', async () => {
    const memory = { notes: 'same', nextAction: '' };
    const loop = await createLoop({ nextRunAt: LATER, idleStreak: 2, memory, activeExecutionIds: ['touched'] });
    const ticket = await createTicket(loop.id, { status: 'blocked', statusReason: 'x' });
    await WorkItem.collection.updateOne({ _id: new mongoose.Types.ObjectId(ticket.id) }, { $set: { updatedAt: PAST } });
    executions.touched = { status: 'completed', result: { answer: 'same' }, createdAt: PAST, completedAt: NOW };
    await runLoopSchedulerTick(NOW, logger);
    expect((await reload(loop.id)).idleStreak).toBe(0);

    await Loop.updateOne({ _id: loop.id }, { $set: { activeExecutionIds: ['changed'], idleStreak: 2 } });
    executions.changed = { status: 'completed', result: { answer: 'news' }, createdAt: NOW, completedAt: NOW };
    await runLoopSchedulerTick(NOW, logger);
    expect((await reload(loop.id)).idleStreak).toBe(0);
  });
});

describe('runLoopSchedulerTick - liveness', () => {
  const DESKTOP = { stages: ['todo', 'review', 'done'], stageConfig: [{ stage: 'review', runner: 'desktop' }] };
  const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
    (
      await WorkItem.create({
        userId: 'user-1',
        loopId,
        title: 'Write the summary',
        stage: 'todo',
        status: 'open',
        dependencies: [],
        priority: 'p2',
        ...overrides,
      })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  // 3 x 15 min interval = 45 min past due; 50 is over it.
  const LONG_DUE = minutesAgo(50);
  const LATER = new Date(NOW.getTime() + 60 * 60_000);
  const keys = async () => (await Inbox.find({ deletedAt: null }).lean()).map(notice => notice.sourceKey);
  /** A loop the scheduler cannot start this tick (an invoke that failed before any run doc), so it stays due. */
  const refuseStarts = () =>
    h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'dispatch_failed', message: 'busy' });

  describe('idle with work', () => {
    it('flags a live loop far past due with a ready ticket, then clears it and its notice once it runs', async () => {
      refuseStarts();
      const loop = await createLoop({ nextRunAt: LONG_DUE });
      await createTicket(loop.id);

      await runLoopSchedulerTick(NOW, logger);

      const flagged = await reload(loop.id);
      expect(flagged.alarm).toMatchObject({
        kind: 'idle_with_work',
        reason: 'Ready tickets waiting, but no run for 50 min past its schedule',
        since: NOW,
      });
      expect(await keys()).toEqual([`loop:${loop.id}:alarm:idle_with_work`]);
      const notice = await Inbox.findOne({ sourceKey: `loop:${loop.id}:alarm:idle_with_work` }).lean();
      expect(notice).toMatchObject({ title: 'Loop "Digest" is idle with ready tickets', link: `/loops/${loop.id}` });

      // Still stuck a tick later: the alarm keeps its start.
      await runLoopSchedulerTick(new Date(NOW.getTime() + 5 * 60_000), logger);
      expect((await reload(loop.id)).alarm?.since).toEqual(NOW);

      h.startAgentExecution.mockResolvedValue({ ok: true, executionId: 'exec-1' });
      await runLoopSchedulerTick(new Date(NOW.getTime() + 10 * 60_000), logger);
      expect((await reload(loop.id)).alarm).toBeUndefined();
      expect(await keys()).toEqual([]);
    });

    it('does not flag a loop whose only ready ticket is in a desktop stage', async () => {
      refuseStarts();
      const loop = await createLoop({ ...DESKTOP, nextRunAt: LONG_DUE });
      await createTicket(loop.id, { stage: 'review' });

      await runLoopSchedulerTick(NOW, logger);

      expect((await reload(loop.id)).alarm).toBeUndefined();
    });

    it('clears the alarm once the loop is paused by its owner', async () => {
      const loop = await createLoop({
        status: 'paused',
        nextRunAt: LONG_DUE,
        alarm: { kind: 'idle_with_work', reason: 'idle', since: PAST },
      });
      await createTicket(loop.id);
      await runLoopSchedulerTick(NOW, logger);
      expect((await reload(loop.id)).alarm).toBeUndefined();
    });

    it('does not flag a loop held back on purpose, or one with no ready ticket', async () => {
      refuseStarts();
      const ids: Record<string, string> = {};
      const make = async (name: string, overrides: Record<string, unknown>, ticket = true) => {
        const loop = await createLoop({ name, nextRunAt: LONG_DUE, ...overrides });
        if (ticket) await createTicket(loop.id);
        ids[name] = loop.id;
      };
      await make('backoff', { idleStreak: 2 });
      await make('budget', { status: 'paused', autoResume: 'budget', statusReason: BUDGET_PAUSE_REASON });
      await make('credits', { status: 'paused', autoResume: 'credits', statusReason: 'Out of credits' });
      await make('allBudget', { status: 'paused', autoResume: 'budget', statusReason: USER_BUDGET_PAUSE_REASON });
      await make('owner', { status: 'paused' });
      await make('noTicket', {}, false);
      await make('closedOnly', {}, false);
      await createTicket(ids.closedOnly, { status: 'closed' });

      await runLoopSchedulerTick(NOW, logger);

      for (const id of Object.values(ids)) expect((await reload(id)).alarm).toBeUndefined();
    });

    it('marks a pacing defer as a pacing hold, never an alarm', async () => {
      vi.spyOn(agentExecutionRepository, 'sumCreditsByLoop').mockImplementation((async (ids: string[]) =>
        Object.fromEntries(ids.map(id => [id, 5]))) as never);
      const early = new Date('2026-10-29T02:30:00Z');
      const loop = await createLoop({ budgetCreditsPerDay: 24, nextRunAt: new Date(early.getTime() - 50 * 60_000) });
      await createTicket(loop.id);

      await runLoopSchedulerTick(early, logger);

      const deferred = await reload(loop.id);
      expect(deferred.hold).toMatchObject({ kind: 'pacing', until: deferred.nextRunAt, at: early });
      expect(deferred.alarm).toBeUndefined();

      await runLoopSchedulerTick(deferred.nextRunAt!, logger);
      expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
      expect((await reload(loop.id)).hold).toBeUndefined();
    });

    it('marks loops left out by the global run cap as capacity holds, recomputed each tick', async () => {
      for (let i = 0; i < 4; i++) {
        await createLoop({ userId: `busy-user-${i}`, activeExecutionIds: [`busy-${i}`], nextRunAt: LATER });
        executions[`busy-${i}`] = { status: 'running', updatedAt: NOW, createdAt: NOW };
      }
      const waiting = await createLoop({ nextRunAt: LONG_DUE });
      await createTicket(waiting.id);

      await runLoopSchedulerTick(NOW, logger);
      expect(h.startAgentExecution).not.toHaveBeenCalled();
      expect(await reload(waiting.id)).toMatchObject({ hold: { kind: 'capacity', limit: 'server', at: NOW } });
      expect((await reload(waiting.id)).alarm).toBeUndefined();

      await Loop.updateMany({ activeExecutionIds: ['busy-0'] }, { $unset: { activeExecutionIds: '' } });
      await runLoopSchedulerTick(NOW, logger);
      const started = await reload(waiting.id);
      expect(started.activeExecutionIds).toEqual(['exec-1']);
      expect(started.hold).toBeUndefined();
    });

    it('a loop made due with a spent budget is still paused by admission', async () => {
      vi.spyOn(agentExecutionRepository, 'sumCreditsByLoop').mockImplementation((async (ids: string[]) =>
        Object.fromEntries(ids.map(id => [id, 10]))) as never);
      const loop = await createLoop({ budgetCreditsPerDay: 10, nextRunAt: LATER, idleStreak: 2 });
      await loopRepository.makeDueNow(loop.id, NOW);

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution).not.toHaveBeenCalled();
      expect(await reload(loop.id)).toMatchObject({ status: 'paused', autoResume: 'budget' });
    });
  });

  describe('long run', () => {
    const completedRun = (id: string, minutes: number) => ({
      id,
      status: 'completed',
      createdAt: new Date(0),
      completedAt: new Date(minutes * 60_000),
    });
    const startLong = async (ageMinutes: number, overrides: Record<string, unknown> = {}) => {
      const loop = await createLoop({ activeExecutionIds: ['exec-long'], nextRunAt: LATER });
      executions['exec-long'] = {
        id: 'exec-long',
        userId: 'user-1',
        status: 'running',
        updatedAt: NOW,
        createdAt: minutesAgo(ageMinutes),
        ...overrides,
      };
      return loop;
    };

    it('flags a run past 3x the median of recent runs, links the notice to it, and the fold clears it', async () => {
      vi.spyOn(agentExecutionRepository, 'listRecentForLoop').mockResolvedValue([
        { id: 'exec-long', status: 'running', createdAt: minutesAgo(100) },
        completedRun('a', 20),
        completedRun('b', 30),
        completedRun('c', 40),
        { id: 'd', status: 'failed', createdAt: new Date(0) },
      ] as never);
      const loop = await startLong(100);

      await runLoopSchedulerTick(NOW, logger);

      expect((await reload(loop.id)).alarm).toEqual({
        kind: 'long_run',
        reason: 'Run going for 100 min, about 3x longer than usual',
        since: NOW,
        executionId: 'exec-long',
      });
      const notice = await Inbox.findOne({ sourceKey: `loop:${loop.id}:alarm:long_run` }).lean();
      expect(notice).toMatchObject({
        title: 'Loop "Digest": run going much longer than usual',
        link: `/loops/${loop.id}?run=exec-long`,
      });

      executions['exec-long'] = { ...executions['exec-long'], status: 'completed', result: { answer: 'done' } };
      await runLoopSchedulerTick(NOW, logger);
      expect((await reload(loop.id)).alarm).toBeUndefined();
      expect(await keys()).toEqual([]);
    });

    it('uses the 60 min floor alone with too few completed runs', async () => {
      vi.spyOn(agentExecutionRepository, 'listRecentForLoop').mockResolvedValue([completedRun('a', 1)] as never);
      const under = await startLong(59);
      await runLoopSchedulerTick(NOW, logger);
      expect((await reload(under.id)).alarm).toBeUndefined();

      executions['exec-long'].createdAt = minutesAgo(61);
      await runLoopSchedulerTick(NOW, logger);
      expect((await reload(under.id)).alarm).toMatchObject({ kind: 'long_run', reason: 'Run going for 61 min' });
    });

    it('does not flag a run under 3x the median, waiting on children, or gate-paused', async () => {
      vi.spyOn(agentExecutionRepository, 'listRecentForLoop').mockResolvedValue([
        completedRun('a', 40),
        completedRun('b', 40),
        completedRun('c', 40),
      ] as never);
      const under = await startLong(110);
      await runLoopSchedulerTick(NOW, logger);
      expect((await reload(under.id)).alarm).toBeUndefined();

      executions['exec-long'] = { ...executions['exec-long'], status: 'awaiting_subagent', createdAt: minutesAgo(500) };
      await runLoopSchedulerTick(NOW, logger);
      expect((await reload(under.id)).alarm).toBeUndefined();

      executions['exec-long'] = { ...executions['exec-long'], status: 'paused', createdAt: minutesAgo(500) };
      await runLoopSchedulerTick(NOW, logger);
      expect((await reload(under.id)).alarm).toBeUndefined();
    });
  });

  describe('stranded tickets', () => {
    const age = (id: string, at: Date) =>
      WorkItem.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { updatedAt: at } });

    it('reopens a claim with no run once it is older than a lease, uncounted, and makes the loop due', async () => {
      const loop = await createLoop({ nextRunAt: LATER });
      const stale = await createTicket(loop.id, { status: 'in_progress', runCount: 1 });
      const fresh = await createTicket(loop.id, { status: 'in_progress', runCount: 1 });
      await age(stale.id, new Date(NOW.getTime() - LOOP_LEASE_MS - 1000));
      await age(fresh.id, new Date(NOW.getTime() - LOOP_LEASE_MS + 60_000));
      refuseStarts();

      await runLoopSchedulerTick(NOW, logger);

      expect(await ticketOf(stale.id)).toMatchObject({ status: 'open', runCount: 0 });
      expect(await ticketOf(fresh.id)).toMatchObject({ status: 'in_progress', runCount: 1 });
      expect((await reload(loop.id)).nextRunAt).toEqual(NOW);
    });

    it('reopens a desktop-stage ticket whose run is gone, and never gives it to a cloud run', async () => {
      const loop = await createLoop({ ...DESKTOP, nextRunAt: LATER });
      const ticket = await createTicket(loop.id, {
        stage: 'review',
        status: 'in_progress',
        executionId: 'exec-gone',
        runCount: 1,
      });
      await age(ticket.id, minutesAgo(60));

      await runLoopSchedulerTick(NOW, logger);

      expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open', runCount: 0 });
      // Only a desktop-stage ticket is ready, so the loop is not made due and no cloud run claims it.
      expect(h.startAgentExecution).not.toHaveBeenCalled();
      expect((await reload(loop.id)).nextRunAt).toEqual(LATER);
    });

    it('waits while the loop has a run in flight that could still link the claim', async () => {
      const loop = await createLoop({ activeExecutionIds: ['exec-a'], nextRunAt: LATER });
      executions['exec-a'] = { status: 'running', updatedAt: NOW, createdAt: NOW };
      const unlinked = await createTicket(loop.id, { status: 'in_progress' });
      await age(unlinked.id, minutesAgo(60));

      await runLoopSchedulerTick(NOW, logger);
      expect(await ticketOf(unlinked.id)).toMatchObject({ status: 'in_progress' });
    });

    it('reopens a ticket whose run is gone or finished; leaves the active, resumed and desktop runs alone', async () => {
      // exec-active is the loop's second lane, so any lane id counts as live.
      const loop = await createLoop({
        maxConcurrent: 2,
        activeExecutionIds: ['exec-other', 'exec-active'],
        nextRunAt: LATER,
      });
      executions['exec-other'] = { status: 'running', updatedAt: NOW, createdAt: NOW };
      executions['exec-active'] = { status: 'running', updatedAt: NOW, createdAt: NOW };
      executions['exec-done'] = { status: 'completed' };
      executions['exec-resumed'] = { status: 'completed' };
      executions['exec-desktop'] = { status: 'completed', runner: 'desktop' };
      executions['exec-live'] = { status: 'running', updatedAt: NOW };
      const ticket = (executionId: string) =>
        createTicket(loop.id, { status: 'in_progress', executionId, runCount: 1 });
      const missing = await ticket('exec-missing');
      const done = await ticket('exec-done');
      const active = await ticket('exec-active');
      const resumed = await ticket('exec-resumed');
      const desktop = await ticket('exec-desktop');
      const live = await ticket('exec-live');
      // A desktop claim links its ticket before the run doc exists, so a fresh claim with no run is left alone.
      const claiming = await ticket('exec-claiming');
      for (const t of [missing, done, active, resumed, desktop, live]) await age(t.id, minutesAgo(60));
      await loopEventRepository.resolveUnsure(
        {
          loopId: loop.id,
          userId: 'user-1',
          executionId: 'exec-resumed',
          iteration: 1,
          confidence: 0.2,
          reason: 'thin',
          requestedAt: new Date(1000),
        } as never,
        { outcome: 'resumed', at: NOW }
      );
      // Keep the resumed fold from running this tick, so only the sweep could touch its ticket.
      vi.spyOn(loopEventRepository, 'listResumedUnfolded').mockResolvedValue([]);

      await runLoopSchedulerTick(NOW, logger);

      for (const t of [missing, done]) {
        const after = await ticketOf(t.id);
        expect(after).toMatchObject({ status: 'open', runCount: 0 });
        expect(after.executionId).toBeUndefined();
      }
      for (const t of [active, resumed, desktop, live, claiming]) {
        expect(await ticketOf(t.id)).toMatchObject({ status: 'in_progress', runCount: 1 });
      }
    });
  });
});

describe('runLoopSchedulerTick - parallel lanes', () => {
  const settings = (values: Record<string, unknown>) =>
    vi
      .mocked(adminSettingsRepository.getSettingsValue)
      .mockImplementation((async (key: string) => (key === 'EnableLoops' ? true : values[key])) as never);
  const createTicket = async (loopId: string, title: string, userId = 'user-1') =>
    (
      await WorkItem.create({ userId, loopId, title, stage: 'todo', status: 'open', dependencies: [], priority: 'p2' })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const loopWithTickets = async (count: number, overrides: Record<string, unknown> = {}) => {
    const loop = await createLoop({ maxConcurrent: 3, ...overrides });
    const tickets = [];
    for (let i = 0; i < count; i++) {
      tickets.push(await createTicket(loop.id, `T${i}`, (overrides.userId as string | undefined) ?? 'user-1'));
    }
    return { loop, tickets };
  };
  /** Each started run gets a real execution doc carrying its creditCap, so later lanes' admission reserves it. */
  const persistRuns = () =>
    h.startAgentExecution.mockImplementation(async (params: Record<string, unknown>) => {
      const doc = await agentExecutionRepository.create({
        userId: params.userId,
        sessionId: params.sessionId,
        questId: params.questId,
        loopId: params.loopId,
        query: 'q',
        model: params.model,
        status: 'running',
        approvedTools: [],
        deniedTools: [],
        iterationBilling: [],
        totalCreditsUsed: 0,
        ...(params.creditCap !== undefined && { creditCap: params.creditCap }),
        ...(params.loopRunKind !== undefined && { loopRunKind: params.loopRunKind }),
        lambdaInvocationCount: 1,
        childExecutionIds: [],
        createdAt: NOW,
      } as never);
      executions[doc.id] = { status: 'running', updatedAt: NOW, createdAt: NOW };
      return { ok: true, executionId: doc.id };
    });
  const caps = () => h.startAgentExecution.mock.calls.map(call => call[0].creditCap as number);

  it('runs one triage in a lane, and while it runs the other lanes work only tickets with a priority', async () => {
    persistRuns();
    const { loop, tickets } = await loopWithTickets(1);
    const untriaged = (
      await WorkItem.create({
        userId: 'user-1',
        loopId: loop.id,
        title: 'New',
        stage: 'todo',
        status: 'open',
        dependencies: [],
      })
    ).toJSON();

    await runLoopSchedulerTick(NOW, logger);
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({ loopRunKind: 'triage' });

    await Loop.updateOne({ _id: loop.id }, { $set: { nextRunAt: NOW } });
    await runLoopSchedulerTick(NOW, logger);
    expect(h.startAgentExecution).toHaveBeenCalledTimes(2);
    expect(h.startAgentExecution.mock.calls[1][0]).toMatchObject({ workItemId: tickets[0].id });
    expect(h.startAgentExecution.mock.calls[1][0]).not.toHaveProperty('loopRunKind');
    expect((await ticketOf(untriaged.id)).status).toBe('open');
    expect((await reload(loop.id)).activeExecutionIds).toHaveLength(2);
  });

  it('waits an interval after an unconfirmed dispatch on a multi-lane loop', async () => {
    const { loop } = await loopWithTickets(2);
    h.startAgentExecution.mockResolvedValue({
      ok: false,
      reason: 'dispatch_failed',
      message: 'unconfirmed',
      executionId: 'exec-7',
    });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    const after = await reload(loop.id);
    expect(after.activeExecutionIds).toEqual(['exec-7']);
    expect(after.nextRunAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
  });

  it('holds a loop with a lane running on budget when the all-loops budget runs out', async () => {
    settings({ LoopsDailyCreditsPerUser: 50 });
    vi.mocked(userRepository.findById).mockResolvedValue({ currentCredits: 1000, loopsDailyCredits: 30 } as never);
    vi.spyOn(agentExecutionRepository, 'sumLoopCreditsForUser').mockResolvedValue(30);
    const { loop } = await loopWithTickets(1, { activeExecutionIds: ['exec-0'] });
    executions['exec-0'] = { status: 'running', updatedAt: NOW, createdAt: NOW };

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    const after = await reload(loop.id);
    expect(after).toMatchObject({ status: 'live', activeExecutionIds: ['exec-0'] });
    expect(after.hold).toMatchObject({ kind: 'capacity', limit: 'budget' });
    expect(after.leaseUntil).toBeUndefined();
  });

  it('opens a lane per ready ticket up to the per-user lane limit, never two runs on one ticket', async () => {
    const { loop, tickets } = await loopWithTickets(3);

    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after.activeExecutionIds).toEqual(['exec-1', 'exec-2']);
    expect(after.hold).toMatchObject({ kind: 'capacity', limit: 'user' });
    const linked = await Promise.all(tickets.map(t => ticketOf(t.id)));
    expect(linked.map(t => t.executionId)).toEqual(['exec-1', 'exec-2', undefined]);
    expect(linked[2].status).toBe('open');
  });

  it("holds on the loop's own lanes when they are all busy with tickets waiting", async () => {
    const { loop } = await loopWithTickets(3, { maxConcurrent: 2 });

    await runLoopSchedulerTick(NOW, logger);

    expect(await reload(loop.id)).toMatchObject({
      activeExecutionIds: ['exec-1', 'exec-2'],
      hold: { kind: 'capacity', limit: 'loop' },
    });
  });

  it('spreads the server-wide lanes one per user per pass', async () => {
    settings({ LoopsMaxActiveRuns: 2 });
    await loopWithTickets(3);
    await loopWithTickets(3, { userId: 'user-2', sessionId: 'session-2' });

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution.mock.calls.map(call => call[0].userId).sort()).toEqual(['user-1', 'user-2']);
  });

  it('folds only the lane that finished, and the next tick refills it', async () => {
    const { loop, tickets } = await loopWithTickets(3, { maxConcurrent: 2 });
    await runLoopSchedulerTick(NOW, logger);

    executions['exec-1'] = { status: 'completed', result: { answer: 'done' }, createdAt: NOW, completedAt: NOW };
    executions['exec-2'] = { status: 'running', updatedAt: NOW, createdAt: NOW };
    await runLoopSchedulerTick(NOW, logger);

    const after = await reload(loop.id);
    expect(after.activeExecutionIds).toEqual(['exec-2', 'exec-3']);
    expect(after.runCount).toBe(1);
    // The advanced ticket is ready again one stage on, so furthest-stage-first gives it the freed lane.
    expect(await ticketOf(tickets[0].id)).toMatchObject({ stage: 'doing', executionId: 'exec-3' });
    expect((await ticketOf(tickets[1].id)).executionId).toBe('exec-2');
  });

  it('never claims one ticket twice or exceeds maxConcurrent across concurrent ticks', async () => {
    const { loop, tickets } = await loopWithTickets(3, { maxConcurrent: 2 });

    await Promise.all([runLoopSchedulerTick(NOW, logger), runLoopSchedulerTick(NOW, logger)]);

    const after = await reload(loop.id);
    expect(after.activeExecutionIds!.length).toBeLessThanOrEqual(2);
    const linked = (await Promise.all(tickets.map(t => ticketOf(t.id)))).map(t => t.executionId).filter(Boolean);
    expect(new Set(linked).size).toBe(linked.length);
    expect(linked.sort()).toEqual([...after.activeExecutionIds!].sort());
  });

  it('starts no goal run beside a running lane, and pushes the loop to its next interval', async () => {
    const loop = await createLoop({ maxConcurrent: 2, activeExecutionIds: ['busy'] });
    executions.busy = { status: 'running', updatedAt: NOW, createdAt: NOW };

    await runLoopSchedulerTick(NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    const after = await reload(loop.id);
    expect(after.nextRunAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    expect(after.leaseUntil).toBeUndefined();
  });

  it("splits the budget across the lanes it opens, and a finished lane's leftover returns", async () => {
    persistRuns();
    // At 12:00 a 24-credit budget's paced allowance is 13: two lanes get 6.5 each.
    const { loop } = await loopWithTickets(3, { budgetCreditsPerDay: 24, maxConcurrent: 2 });

    await runLoopSchedulerTick(NOW, logger);

    expect(caps()).toHaveLength(2);
    expect(caps()[0]).toBeCloseTo(6.5);
    expect(caps()[1]).toBeCloseTo(6.5);

    // The first lane finishes having used 1 credit: its reservation drops to 1, so the next lane gets 13 - 1 - 6.5.
    const [first] = (await reload(loop.id)).activeExecutionIds!;
    await agentExecutionRepository.update({ id: first, status: 'completed', totalCreditsUsed: 1 } as never);
    executions[first] = { status: 'completed', result: { answer: 'done' }, createdAt: NOW, completedAt: NOW };
    await runLoopSchedulerTick(NOW, logger);

    expect(caps()).toHaveLength(3);
    expect(caps()[2]).toBeCloseTo(13 - 1 - 6.5);
  });

  it("holds the loop on budget when a lane's share is under one iteration", async () => {
    const late = new Date('2026-10-29T23:30:00Z');
    // 0.015 left covers one 0.01-credit iteration, but not two lanes' shares of it.
    const { loop, tickets } = await loopWithTickets(2, { budgetCreditsPerDay: 0.015, maxConcurrent: 2 });

    await runLoopSchedulerTick(late, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect((await reload(loop.id)).hold).toMatchObject({ kind: 'capacity', limit: 'budget' });
    for (const t of tickets) expect((await ticketOf(t.id)).status).toBe('open');
  });

  it('caps a single-lane loop exactly as before', async () => {
    persistRuns();
    await loopWithTickets(3, { budgetCreditsPerDay: 24, maxConcurrent: 1 });
    await runLoopSchedulerTick(NOW, logger);
    expect(caps()).toHaveLength(1);
    expect(caps()[0]).toBeCloseTo(13);
  });
});

describe('runLoopSchedulerTick - priority policy', () => {
  const STAGES = ['todo', 'review', 'done'];
  const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
    (
      await WorkItem.create({
        userId: 'user-1',
        loopId,
        title: 'Write the summary',
        stage: 'todo',
        status: 'open',
        dependencies: [],
        priority: 'p2',
        prioritySetBy: 'agent',
        ...overrides,
      })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const MIDNIGHT = new Date('2026-10-30T00:00:00Z');
  /** A run of a p2 ticket already started today: a desktop run doc, which counts like a cloud one. */
  const p2RunToday = (loopId: string) =>
    agentExecutionRepository.createRunnerRun(new mongoose.Types.ObjectId().toString(), {
      userId: 'user-1',
      sessionId: 'session-1',
      questId: 'session-1',
      query: 'q',
      model: 'claude-sonnet-5',
      status: 'running',
      connectionId: 'headless',
      approvedTools: [],
      deniedTools: [],
      iterationBilling: [],
      totalCreditsUsed: 0,
      lambdaInvocationCount: 0,
      childExecutionIds: [],
      loopId,
      workItemId: 'some-ticket',
      ticketPriority: 'p2',
      checkpoint: { steps: [], iteration: 0, pendingText: '', seq: 0 },
      runnerLeaseUntil: NOW,
    } as never);

  describe('triage', () => {
    it('runs an untriaged ticket through a triage run on triageModel, claiming nothing', async () => {
      const loop = await createLoop({ stages: STAGES, triageModel: 'cheap' });
      const untriaged = await createTicket(loop.id, { priority: undefined, prioritySetBy: undefined });
      await createTicket(loop.id, { priority: 'p0' });

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
      const input = h.startAgentExecution.mock.calls[0][0];
      expect(input).toMatchObject({ model: 'cheap', loopRunKind: 'triage', enabledTools: [], loopId: loop.id });
      expect(input).not.toHaveProperty('workItemId');
      expect(input.query).toContain(`Ticket id: ${untriaged.id}`);
      expect(await ticketOf(untriaged.id)).toMatchObject({ status: 'open', runCount: 0 });
      expect(await ticketOf(untriaged.id)).not.toHaveProperty('executionId');
    });

    it("tells a triage run not to split the tickets in the loop's desktop stages", async () => {
      const loop = await createLoop({ stages: STAGES, stageConfig: [{ stage: 'review', runner: 'desktop' }] });
      await createTicket(loop.id, { priority: undefined, stage: 'review' });

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution.mock.calls[0][0].query).toContain(
        `Tickets in the "review" stage(s) are worked by the\nowner's desktop app: only set their priority, never split them.`
      );
    });

    it('prices a triage run on triageModel', async () => {
      h.getAvailableModels.mockResolvedValue([{ id: 'claude-sonnet-5' }, { id: 'cheap' }]);
      h.nextIterationCredits.mockImplementation((model: { id: string }) => (model.id === 'cheap' ? 20 : 1));
      const loop = await createLoop({ stages: STAGES, triageModel: 'cheap', budgetCreditsPerDay: 10 });
      await createTicket(loop.id, { priority: undefined });

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution).not.toHaveBeenCalled();
      expect(await reload(loop.id)).toMatchObject({ status: 'paused', statusReason: BUDGET_PAUSE_REASON });
    });

    it("folds a triage run without touching the loop's memory", async () => {
      const memory = { notes: 'kept', nextAction: 'keep going' };
      const loop = await createLoop({ stages: STAGES, activeExecutionIds: ['exec-t'], memory });
      executions['exec-t'] = {
        status: 'completed',
        loopRunKind: 'triage',
        createdAt: minutesAgo(5),
        completedAt: NOW,
        result: { answer: 'Set 2.\n```loop-memory\n{ "notes": "overwritten", "nextAction": "x" }\n```' },
      };

      await runLoopSchedulerTick(NOW, logger);

      const folded = await reload(loop.id);
      expect(folded.memory).toMatchObject(memory);
      expect(folded.activeExecutionIds ?? []).toEqual([]);
      expect(folded.lastRunAt).toEqual(NOW);
    });

    it('sets p2 at the fold on a ticket the triage run was shown but left, so ticket work goes on', async () => {
      const loop = await createLoop({ stages: STAGES, activeExecutionIds: ['exec-t'] });
      const skipped = await createTicket(loop.id, { priority: undefined, prioritySetBy: undefined });
      const unseen = await createTicket(loop.id, { priority: undefined, prioritySetBy: undefined });
      const owned = await createTicket(loop.id, { priority: 'p1', prioritySetBy: 'owner' });
      executions['exec-t'] = {
        status: 'completed',
        loopRunKind: 'triage',
        triageWorkItemIds: [skipped.id, owned.id],
        createdAt: minutesAgo(5),
        completedAt: NOW,
        result: { answer: 'Could not decide.' },
      };

      await runLoopSchedulerTick(NOW, logger);

      expect(await ticketOf(skipped.id)).toMatchObject({ priority: 'p2', prioritySetBy: 'agent' });
      expect(await ticketOf(owned.id)).toMatchObject({ priority: 'p1', prioritySetBy: 'owner' });
      expect(await ticketOf(unseen.id)).not.toHaveProperty('priority');
      // It set nothing itself, so it still folds as idle.
      expect((await reload(loop.id)).idleStreak).toBe(1);
    });

    it('dispatches ticket work unchanged when nothing is untriaged', async () => {
      const loop = await createLoop({ stages: STAGES, triageModel: 'cheap' });
      const ticket = await createTicket(loop.id, { priority: 'p1' });

      await runLoopSchedulerTick(NOW, logger);

      const input = h.startAgentExecution.mock.calls[0][0];
      expect(input).toMatchObject({ model: 'claude-sonnet-5', workItemId: ticket.id, ticketPriority: 'p1' });
      expect(input).not.toHaveProperty('loopRunKind');
    });
  });

  describe('p2 daily cap', () => {
    it('claims a p1 over an older p2 once the p2 runs are used up', async () => {
      const loop = await createLoop({ stages: STAGES, p2RunsPerDay: 1 });
      await createTicket(loop.id, { title: 'Older p2' });
      const p1 = await createTicket(loop.id, { title: 'p1', priority: 'p1' });
      await p2RunToday(loop.id);

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({ workItemId: p1.id, ticketPriority: 'p1' });
    });

    it('holds the loop until 00:00 UTC instead of a goal run when only p2/p3 are ready, and does not flag it idle', async () => {
      const loop = await createLoop({ stages: STAGES, p2RunsPerDay: 1, nextRunAt: minutesAgo(50) });
      const p2 = await createTicket(loop.id, { prioritySetBy: 'owner' });
      await createTicket(loop.id, { title: 'p3', priority: 'p3' });
      await p2RunToday(loop.id);

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution).not.toHaveBeenCalled();
      const held = await reload(loop.id);
      expect(held).toMatchObject({
        status: 'live',
        nextRunAt: MIDNIGHT,
        hold: { kind: 'priority_budget', until: MIDNIGHT, at: NOW },
      });
      expect(held.leaseUntil).toBeUndefined();
      expect(held.alarm).toBeUndefined();
      expect(await ticketOf(p2.id)).toMatchObject({ status: 'open', priority: 'p2', runCount: 0 });

      // A new p1 makes it due early, and the run clears the hold.
      const p1 = await createTicket(loop.id, { title: 'Urgent', priority: 'p1' });
      await makeDueIfReady(await reload(loop.id), NOW);
      await runLoopSchedulerTick(new Date(NOW.getTime() + 60_000), logger);
      expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({ workItemId: p1.id });
      expect((await reload(loop.id)).hold).toBeUndefined();
    });

    it('runs the goal, not a hold, when the only ready cloud ticket over the cap is a p0 at its run limit', async () => {
      const loop = await createLoop({ stages: STAGES, p2RunsPerDay: 1 });
      const spent = await createTicket(loop.id, { priority: 'p0', runCount: 6 });
      await p2RunToday(loop.id);

      await runLoopSchedulerTick(NOW, logger);

      expect(await ticketOf(spent.id)).toMatchObject({ status: 'blocked' });
      expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
      expect(h.startAgentExecution.mock.calls[0][0]).not.toHaveProperty('workItemId');
      expect((await reload(loop.id)).hold).toBeUndefined();
    });

    it('blocks a p2 at its run limit over the cap now, rather than holding the loop until 00:00 UTC', async () => {
      const loop = await createLoop({ stages: STAGES, p2RunsPerDay: 1 });
      const spent = await createTicket(loop.id, { prioritySetBy: 'owner', runCount: 6 });
      await p2RunToday(loop.id);

      await runLoopSchedulerTick(NOW, logger);

      expect(await ticketOf(spent.id)).toMatchObject({ status: 'blocked' });
      expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
      expect(h.startAgentExecution.mock.calls[0][0]).not.toHaveProperty('workItemId');
      expect((await reload(loop.id)).hold).toBeUndefined();
    });

    it('demotes the newest agent-set p2s beyond the day, never an owner-set one, and keeps an owner reset', async () => {
      refuseStartsForCap();
      const loop = await createLoop({ stages: STAGES, p2RunsPerDay: 1 });
      const oldest = await createTicket(loop.id, { title: 'Oldest' });
      const middle = await createTicket(loop.id, { title: 'Middle' });
      const owner = await createTicket(loop.id, { title: 'Owner', prioritySetBy: 'owner' });
      const newest = await createTicket(loop.id, { title: 'Newest' });

      await runLoopSchedulerTick(NOW, logger);

      expect((await ticketOf(oldest.id)).priority).toBe('p2');
      expect(await ticketOf(owner.id)).toMatchObject({ priority: 'p2', prioritySetBy: 'owner' });
      for (const demoted of [middle, newest]) {
        expect(await ticketOf(demoted.id)).toMatchObject({ priority: 'p3', prioritySetBy: 'demote' });
      }

      // The owner sets one back to p2: it is sticky from then on.
      await WorkItem.updateOne({ _id: newest.id }, { $set: { priority: 'p2', prioritySetBy: 'owner' } });
      await Loop.updateOne({ _id: loop.id }, { $set: { nextRunAt: PAST } });
      await runLoopSchedulerTick(new Date(NOW.getTime() + 60_000), logger);
      expect(await ticketOf(newest.id)).toMatchObject({ priority: 'p2', prioritySetBy: 'owner' });
    });

    it('changes nothing with p2RunsPerDay unset', async () => {
      const loop = await createLoop({ stages: STAGES });
      const p2 = await createTicket(loop.id);
      await createTicket(loop.id, { title: 'Newer' });
      await p2RunToday(loop.id);

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({ workItemId: p2.id, ticketPriority: 'p2' });
      expect(await WorkItem.countDocuments({ priority: 'p3' })).toBe(0);
    });

    /** A start the user's concurrent-run limit refuses, so a tick runs the demote pass but starts nothing. */
    function refuseStartsForCap() {
      h.startAgentExecution.mockResolvedValue({ ok: false, reason: 'concurrent_limit', message: 'busy' });
    }
  });

  describe('escalation', () => {
    // Three stages: a run limit of 6, so the run from runCount 5 is the last.
    it("runs a ticket's last run on the escalation model, marked escalated, and earlier runs on the stage model", async () => {
      const stageConfig = [{ stage: 'todo', model: 'stage-model' }];
      const loop = await createLoop({ stages: STAGES, stageConfig, escalationModel: 'strong' });
      const last = await createTicket(loop.id, { runCount: 5 });

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution.mock.calls[0][0]).toMatchObject({
        model: 'strong',
        escalated: true,
        workItemId: last.id,
      });

      const other = await createLoop({ stages: STAGES, stageConfig, escalationModel: 'strong', sessionId: 's-2' });
      // Older, so tried first: blocked at its limit, and the next ticket is worked.
      const spent = await createTicket(other.id, { title: 'Spent', runCount: 6 });
      await createTicket(other.id, { runCount: 4 });
      await runLoopSchedulerTick(NOW, logger);
      const input = h.startAgentExecution.mock.calls[1][0];
      expect(input).toMatchObject({ model: 'stage-model', loopId: other.id });
      expect(input).not.toHaveProperty('escalated');
      expect(await ticketOf(spent.id)).toMatchObject({
        status: 'blocked',
        statusReason: 'Ran 6 times without finishing',
      });
    });

    it("prefers the stage's escalation model, and prices admission on it", async () => {
      h.getAvailableModels.mockResolvedValue([{ id: 'claude-sonnet-5' }, { id: 'strong' }, { id: 'stage-strong' }]);
      h.nextIterationCredits.mockImplementation((model: { id: string }) => (model.id === 'stage-strong' ? 20 : 1));
      const loop = await createLoop({
        stages: STAGES,
        stageConfig: [{ stage: 'todo', escalationModel: 'stage-strong' }],
        escalationModel: 'strong',
        budgetCreditsPerDay: 10,
      });
      const ticket = await createTicket(loop.id, { runCount: 5 });

      await runLoopSchedulerTick(NOW, logger);

      expect(h.startAgentExecution).not.toHaveBeenCalled();
      expect(await reload(loop.id)).toMatchObject({ status: 'paused', statusReason: BUDGET_PAUSE_REASON });
      expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open', runCount: 5 });
    });

    it('caps an escalated run from the escalation model', async () => {
      h.getAvailableModels.mockResolvedValue([{ id: 'claude-sonnet-5' }, { id: 'strong' }]);
      h.nextIterationCredits.mockImplementation((model: { id: string }) => (model.id === 'strong' ? 3 : 1));
      const loop = await createLoop({ stages: STAGES, escalationModel: 'strong', budgetCreditsPerDay: 10 });
      await createTicket(loop.id, { runCount: 5 });

      await runLoopSchedulerTick(NOW, logger);

      const input = h.startAgentExecution.mock.calls[0][0];
      expect(input).toMatchObject({ model: 'strong', escalated: true });
      expect(input.creditCap).toBeGreaterThan(0);
    });
  });
});

describe('dispatchLoopNow', () => {
  const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
    (
      await WorkItem.create({
        userId: 'user-1',
        loopId,
        title: 'Write the summary',
        stage: 'todo',
        status: 'open',
        dependencies: [],
        priority: 'p2',
        ...overrides,
      })
    ).toJSON();
  const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
  const LATER = new Date(NOW.getTime() + 60 * 60_000);

  it('starts a due live loop on its ready ticket and pushes the change to its page', async () => {
    const loop = await createLoop();
    const ticket = await createTicket(loop.id);

    await dispatchLoopNow(loop.id, NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'in_progress', executionId: 'exec-1' });
    expect(await reload(loop.id)).toMatchObject({ activeExecutionIds: ['exec-1'] });
    expect(h.pushLoopChanged).toHaveBeenCalledWith('user-1', loop.id, logger);
  });

  it('is a no-op for a loop that is not due, with no push', async () => {
    const loop = await createLoop({ nextRunAt: LATER });
    await createTicket(loop.id);

    await dispatchLoopNow(loop.id, NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(h.pushLoopChanged).not.toHaveBeenCalled();
  });

  it('does nothing when EnableLoops is off', async () => {
    vi.mocked(adminSettingsRepository.getSettingsValue).mockResolvedValue(false as never);
    const loop = await createLoop({ activeExecutionIds: ['exec-0'] });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await dispatchLoopNow(loop.id, NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect(await reload(loop.id)).toMatchObject({ activeExecutionIds: ['exec-0'] });
  });

  it('starts nothing while every loop run slot is taken', async () => {
    for (let i = 0; i < MAX_ACTIVE_LOOP_RUNS; i++)
      await createLoop({ activeExecutionIds: [`busy-${i}`], nextRunAt: LATER });
    const loop = await createLoop();

    await dispatchLoopNow(loop.id, NOW, logger);

    expect(h.startAgentExecution).not.toHaveBeenCalled();
    expect((await reload(loop.id)).leaseUntil).toBeUndefined();
  });

  it('folds a finished run, advances its ticket and starts the next run in the same call', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    const ticket = await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0' });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await dispatchLoopNow(loop.id, NOW, logger);

    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'doing', status: 'in_progress', executionId: 'exec-1' });
    expect(await reload(loop.id)).toMatchObject({ activeExecutionIds: ['exec-1'], runCount: 1 });
  });

  it('gives a freed slot to the longest-due loop, not back to the loop whose run ended', async () => {
    for (let i = 0; i < MAX_ACTIVE_LOOP_RUNS - 1; i++)
      await createLoop({ activeExecutionIds: [`busy-${i}`], nextRunAt: LATER });
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0' });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };
    const waiting = await createLoop({ userId: 'user-2', nextRunAt: new Date(PAST.getTime() - 60_000) });

    await dispatchLoopNow(loop.id, NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(await reload(waiting.id)).toMatchObject({ activeExecutionIds: ['exec-1'] });
    expect((await reload(loop.id)).activeExecutionIds ?? []).toEqual([]);
    // The fold still shows on the ended loop's page.
    expect(h.pushLoopChanged).toHaveBeenCalledWith('user-1', loop.id, logger);
  });

  it('with free slots, still starts this loop after an older due loop takes the first one', async () => {
    const waiting = await createLoop({ userId: 'user-2', nextRunAt: new Date(PAST.getTime() - 60_000) });
    const loop = await createLoop();
    const ticket = await createTicket(loop.id);

    await dispatchLoopNow(loop.id, NOW, logger);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(2);
    expect((await reload(waiting.id)).activeExecutionIds).toEqual(['exec-1']);
    expect((await reload(loop.id)).activeExecutionIds).toEqual(['exec-2']);
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'in_progress', executionId: 'exec-2' });
  });

  it('is a no-op for a loop that does not exist', async () => {
    await dispatchLoopNow(new mongoose.Types.ObjectId().toString(), NOW, logger);
    expect(h.startAgentExecution).not.toHaveBeenCalled();
  });

  it('never starts a run on a desktop-stage ticket', async () => {
    const loop = await createLoop({
      stages: ['todo', 'review', 'done'],
      stageConfig: [{ stage: 'review', runner: 'desktop' }],
    });
    const ticket = await createTicket(loop.id, { stage: 'review' });

    await dispatchLoopNow(loop.id, NOW, logger);

    // The loop still runs, as a plain goal run; the desktop ticket waits for its runner.
    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(h.startAgentExecution.mock.calls[0][0].query).not.toContain('Ticket id:');
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open' });
  });

  it('with the tick and events firing together, starts one run and claims the ticket once', async () => {
    const loop = await createLoop();
    const ticket = await createTicket(loop.id);

    await Promise.all([
      runLoopSchedulerTick(NOW, logger),
      dispatchLoopNow(loop.id, NOW, logger),
      dispatchLoopNow(loop.id, NOW, logger),
    ]);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'in_progress', runCount: 1 });
  });

  it('with the tick and events firing together on a finished run, folds it once and starts one next run', async () => {
    const loop = await createLoop({ activeExecutionIds: ['exec-0'], nextRunAt: LATER });
    const ticket = await createTicket(loop.id, { status: 'in_progress', executionId: 'exec-0' });
    executions['exec-0'] = { status: 'completed', result: { answer: 'done' } };

    await Promise.all([
      runLoopSchedulerTick(NOW, logger),
      dispatchLoopNow(loop.id, NOW, logger),
      dispatchLoopNow(loop.id, NOW, logger),
    ]);

    expect(h.startAgentExecution).toHaveBeenCalledTimes(1);
    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'doing', status: 'in_progress', executionId: 'exec-1' });
    expect(await reload(loop.id)).toMatchObject({ activeExecutionIds: ['exec-1'], runCount: 1 });
  });
});
