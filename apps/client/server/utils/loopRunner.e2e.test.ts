import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  Loop,
  organizationRepository,
  userRepository,
  WorkItem,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/**
 * Real-Mongo tests for the desktop runner: claims, leases and folds are conditional writes, so their
 * guarantees only mean something against a mongod. Pricing and the WebSocket send are mocked.
 */

const h = vi.hoisted(() => ({ send: vi.fn(), getAvailableModels: vi.fn() }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.test' } } }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToConnection: h.send }));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: h.getAvailableModels,
}));

import {
  claimRunnerTicket,
  completeRunnerRun,
  heartbeatRunnerRun,
  isRefusal,
  listRunnerTickets,
  progressRunnerRun,
  releaseExpiredRunnerLeases,
  resolveLoopRunTag,
} from './loopRunner';
import { buildLoopQuery } from './loopMemory';
import type { RunnerClaim } from '@bike4mind/common';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The model is not exported under its own name; the repository's import registered it.
const AgentExecution = mongoose.model('AgentExecution');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const NOW = new Date('2026-11-04T12:00:00Z');
const USER = 'user-1';
const STAGES = ['todo', 'build', 'review', 'done'];

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(() => {
  vi.spyOn(adminSettingsRepository, 'getSettingsValue').mockImplementation(
    (async (key: string) => key === 'EnableLoops') as never
  );
  vi.spyOn(userRepository, 'findById').mockResolvedValue({ currentCredits: 1000 } as never);
  h.getAvailableModels.mockResolvedValue([]);
  h.send.mockResolvedValue(undefined);
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.restoreAllMocks();
  h.send.mockReset();
});

const createLoop = async (overrides: Record<string, unknown> = {}) =>
  (
    await Loop.create({
      userId: USER,
      name: 'Ship it',
      goal: 'Ship the backlog',
      model: 'loop-model',
      sessionId: 'session-1',
      intervalMinutes: 15,
      tools: ['web_search'],
      status: 'live',
      nextRunAt: new Date(NOW.getTime() + 60 * 60_000),
      stages: STAGES,
      stageConfig: [
        {
          stage: 'build',
          runner: 'desktop',
          model: 'stage-model',
          instructions: 'Open a PR',
          repoHint: 'acme/app',
          mergePolicy: 'green-ci',
          holdLabels: ['hold'],
        },
      ],
      ...overrides,
    })
  ).toJSON();

const createTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
  (
    await WorkItem.create({
      userId: USER,
      loopId,
      title: 'Add the button',
      description: 'A blue one',
      status: 'open',
      stage: 'build',
      dependencies: [],
      ...overrides,
    })
  ).toJSON();

const ticketOf = async (id: string) => (await WorkItem.findById(id))!.toJSON();
const runOf = async (id: string) => (await AgentExecution.findById(id))!.toObject();
const loopOf = async (id: string) => (await Loop.findById(id))!.toJSON();

const claim = async (ticketId: string, at = NOW): Promise<RunnerClaim> => {
  const result = await claimRunnerTicket(USER, ticketId, at, logger);
  if (isRefusal(result)) throw new Error(`claim refused: ${result.reason}`);
  return result;
};

describe('listRunnerTickets', () => {
  it("lists only open, ready tickets in desktop stages of the caller's live loops, with the repo hint", async () => {
    const loop = await createLoop();
    const ready = await createTicket(loop.id);
    const dep = await createTicket(loop.id, { stage: 'todo' });
    await createTicket(loop.id, { title: 'Waits on a dep', dependencies: [dep.id] });
    await createTicket(loop.id, { title: 'Busy', status: 'in_progress' });
    await createTicket(loop.id, { title: 'Cloud', stage: 'review' });
    const paused = await createLoop({ status: 'paused' });
    await createTicket(paused.id);
    const theirs = await createLoop({ userId: 'user-2' });
    await createTicket(theirs.id, { userId: 'user-2' });

    expect(await listRunnerTickets(USER, NOW)).toEqual([
      {
        ticketId: ready.id,
        title: 'Add the button',
        loopId: loop.id,
        loopName: 'Ship it',
        stage: 'build',
        repoHint: 'acme/app',
      },
    ]);
  });

  it('skips a loop that has spent its daily budget', async () => {
    const loop = await createLoop({ budgetCreditsPerDay: 5 });
    await createTicket(loop.id);
    await AgentExecution.create({
      userId: USER,
      sessionId: 'session-1',
      questId: 'session-1',
      query: 'q',
      model: 'm',
      status: 'completed',
      loopId: loop.id,
      totalCreditsUsed: 5,
      createdAt: NOW,
    });

    expect(await listRunnerTickets(USER, NOW)).toEqual([]);
  });
});

describe('claimRunnerTicket', () => {
  it('claims the ticket under a new leased run and serves the cloud prompt, the stage model and guards', async () => {
    const loop = await createLoop();
    const ticket = await createTicket(loop.id);

    const result = await claim(ticket.id);

    expect(result).toMatchObject({
      ticket: { ticketId: ticket.id, stage: 'build', repoHint: 'acme/app' },
      leaseExpiresAt: new Date(NOW.getTime() + 2 * 60_000).toISOString(),
      model: 'stage-model',
      tools: ['web_search'],
      stage: { mergePolicy: 'green-ci', guards: { holdLabels: ['hold'] } },
    });
    expect(result.prompt).toBe(
      buildLoopQuery(
        loop.goal,
        loop.memory,
        { item: await ticketOf(ticket.id), stages: STAGES, answers: [], instructions: 'Open a PR' },
        { directives: [], overseen: [] }
      )
    );
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'in_progress', executionId: result.runId, runCount: 1 });
    expect(await runOf(result.runId)).toMatchObject({
      userId: USER,
      sessionId: 'session-1',
      loopId: loop.id,
      runner: 'desktop',
      status: 'running',
      model: 'stage-model',
      query: result.prompt,
      runnerLeaseUntil: new Date(NOW.getTime() + 2 * 60_000),
    });
    expect((await loopOf(loop.id)).activeExecutionId).toBeUndefined();
  });

  it("serves green-ci as review when the loop's org turned it off", async () => {
    vi.spyOn(organizationRepository, 'findById').mockResolvedValue({
      id: 'org-1',
      currentCredits: 1000,
      userDetails: [],
      loopsGreenCiMergeDisabled: true,
    } as never);
    const loop = await createLoop({ organizationId: 'org-1' });
    const ticket = await createTicket(loop.id);

    expect((await claim(ticket.id)).stage.mergePolicy).toBe('review');
  });

  it('refuses a claimed ticket, a cloud-stage one, and one past the desktop lane cap', async () => {
    const loop = await createLoop();
    const first = await createTicket(loop.id);
    await claim(first.id);
    expect(await claimRunnerTicket(USER, first.id, NOW, logger)).toMatchObject({ status: 409, reason: 'not_open' });

    const cloud = await createTicket(loop.id, { stage: 'review' });
    expect(await claimRunnerTicket(USER, cloud.id, NOW, logger)).toMatchObject({
      status: 409,
      reason: 'not_desktop_stage',
    });

    for (let i = 0; i < 3; i++) await claim((await createTicket(loop.id)).id);
    const fifth = await createTicket(loop.id);
    expect(await claimRunnerTicket(USER, fifth.id, NOW, logger)).toMatchObject({ status: 409, reason: 'lanes_full' });
    expect(await ticketOf(fifth.id)).toMatchObject({ status: 'open' });

    const theirs = await createTicket(loop.id, { userId: 'user-2' });
    expect(await claimRunnerTicket(USER, theirs.id, NOW, logger)).toMatchObject({ status: 404 });
  });

  it('refuses when the payer cannot pay or the loop budget is spent, creating nothing', async () => {
    const loop = await createLoop({ budgetCreditsPerDay: 5 });
    const ticket = await createTicket(loop.id);
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ currentCredits: 0 } as never);
    expect(await claimRunnerTicket(USER, ticket.id, NOW, logger)).toMatchObject({ status: 409, reason: 'credits' });

    vi.spyOn(userRepository, 'findById').mockResolvedValue({ currentCredits: 1000 } as never);
    await AgentExecution.create({
      userId: USER,
      sessionId: 'session-1',
      questId: 'session-1',
      query: 'q',
      model: 'm',
      status: 'completed',
      loopId: loop.id,
      totalCreditsUsed: 5,
    });
    expect(await claimRunnerTicket(USER, ticket.id, NOW, logger)).toMatchObject({ status: 409, reason: 'loop_budget' });
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open' });
    expect(await AgentExecution.countDocuments({ runner: 'desktop' })).toBe(0);
  });

  it('blocks a ticket that used up its runs', async () => {
    const loop = await createLoop();
    const ticket = await createTicket(loop.id, { runCount: 9 });

    expect(await claimRunnerTicket(USER, ticket.id, NOW, logger)).toMatchObject({ status: 409, reason: 'run_limit' });
    expect(await ticketOf(ticket.id)).toMatchObject({
      status: 'blocked',
      statusReason: 'Ran 9 times without finishing',
    });
  });
});

describe('heartbeat and progress', () => {
  it('renews the lease, and returns 410 once the run is completed or past its credit cap', async () => {
    const loop = await createLoop();
    const ticket = await createTicket(loop.id);
    const { runId } = await claim(ticket.id);
    const later = new Date(NOW.getTime() + 60_000);

    expect(await heartbeatRunnerRun(USER, runId, later, logger)).toEqual({
      leaseExpiresAt: new Date(later.getTime() + 2 * 60_000).toISOString(),
    });
    expect(await heartbeatRunnerRun('user-2', runId, later, logger)).toMatchObject({ status: 404 });

    await AgentExecution.updateOne({ _id: runId }, { $set: { creditCap: 3, totalCreditsUsed: 3 } });
    expect(await heartbeatRunnerRun(USER, runId, later, logger)).toMatchObject({ status: 410, reason: 'credit_cap' });
    expect(await runOf(runId)).toMatchObject({ status: 'failed', failureReason: 'credit_cap' });
    expect(await ticketOf(ticket.id)).toMatchObject({ status: 'open', runCount: 0 });
    expect((await loopOf(loop.id)).statusReason).toBe('Last desktop run stopped at its credit cap (3 credits)');
    expect(await heartbeatRunnerRun(USER, runId, later, logger)).toMatchObject({ status: 410, reason: 'run_ended' });
  });

  it('returns 410 once the lease lapsed', async () => {
    const loop = await createLoop();
    const { runId } = await claim((await createTicket(loop.id)).id);

    expect(await heartbeatRunnerRun(USER, runId, new Date(NOW.getTime() + 3 * 60_000), logger)).toMatchObject({
      status: 410,
      reason: 'lease_lost',
    });
  });

  it('persists progress as executor steps and relays it to the viewers, dropping a gone one', async () => {
    const loop = await createLoop();
    const { runId } = await claim((await createTicket(loop.id)).id);
    await AgentExecution.updateOne({ _id: runId }, { $set: { viewerConnectionIds: ['live', 'gone'] } });
    h.send.mockImplementation(async (connectionId: string) => {
      if (connectionId === 'gone') throw Object.assign(new Error('gone'), { name: 'GoneException' });
    });

    await progressRunnerRun(
      USER,
      runId,
      [
        { type: 'text', text: 'Reading the repo' },
        { type: 'tool-start', callId: 'c1', name: 'read_file', input: '{"path":"a.ts"}' },
      ],
      NOW,
      logger
    );
    expect(
      await progressRunnerRun(
        USER,
        runId,
        [{ type: 'tool-end', callId: 'c1', name: 'read_file', status: 'ok', preview: 'export {}' }],
        NOW,
        logger
      )
    ).toEqual({ leaseExpiresAt: new Date(NOW.getTime() + 2 * 60_000).toISOString() });

    const run = await runOf(runId);
    expect(run.checkpoint).toMatchObject({
      iteration: 1,
      pendingText: '',
      steps: [
        { type: 'thought', content: 'Reading the repo', metadata: { iteration: 0 } },
        { type: 'action', content: 'read_file', metadata: { toolName: 'read_file', toolInput: { path: 'a.ts' } } },
        { type: 'observation', content: 'export {}', metadata: { iteration: 0 } },
      ],
    });
    expect(run.viewerConnectionIds).toEqual(['live']);
    const sent = h.send.mock.calls.filter(([id]) => id === 'live').map(([, , frame]) => frame);
    expect(sent.map(frame => frame.action)).toEqual([
      'agent_text_delta',
      'iteration_step',
      'iteration_step',
      'iteration_step',
    ]);
    expect(sent[0]).toEqual({
      action: 'agent_text_delta',
      executionId: runId,
      iteration: 0,
      delta: 'Reading the repo',
    });
  });
});

describe('completeRunnerRun', () => {
  const memoryAnswer = 'Done.\n```loop-memory\n{ "notes": "PR opened", "nextAction": "review it" }\n```';

  it('advances the ticket to the next stage, writes the loop memory and makes a cloud stage due', async () => {
    const loop = await createLoop();
    const ticket = await createTicket(loop.id);
    const { runId } = await claim(ticket.id);

    expect(
      await completeRunnerRun(USER, runId, { outcome: 'advanced', answer: memoryAnswer, durationMs: 1234 }, NOW, logger)
    ).toEqual({ ok: true });

    expect(await runOf(runId)).toMatchObject({
      status: 'completed',
      result: { answer: memoryAnswer },
      runnerDurationMs: 1234,
    });
    expect(await ticketOf(ticket.id)).toMatchObject({ stage: 'review', status: 'open' });
    const after = await loopOf(loop.id);
    expect(after.memory).toMatchObject({ notes: 'PR opened', nextAction: 'review it' });
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toEqual(NOW);
    expect(
      await completeRunnerRun(USER, runId, { outcome: 'advanced', answer: '', durationMs: 1 }, NOW, logger)
    ).toMatchObject({
      status: 410,
    });
  });

  it('blocks the ticket on blocked or failed, leaving the loop failure count alone', async () => {
    const loop = await createLoop();
    const blocked = await createTicket(loop.id);
    const failed = await createTicket(loop.id);
    const first = await claim(blocked.id);
    const second = await claim(failed.id);

    await completeRunnerRun(
      USER,
      first.runId,
      { outcome: 'blocked', reason: 'Need a key', durationMs: 1 },
      NOW,
      logger
    );
    await completeRunnerRun(
      USER,
      second.runId,
      { outcome: 'failed', reason: 'git crashed', durationMs: 1 },
      NOW,
      logger
    );

    expect(await ticketOf(blocked.id)).toMatchObject({ status: 'blocked', statusReason: 'Need a key' });
    expect(await ticketOf(failed.id)).toMatchObject({
      status: 'blocked',
      statusReason: 'Desktop run failed: git crashed',
    });
    expect(await runOf(second.runId)).toMatchObject({
      status: 'failed',
      error: { message: 'git crashed', callerSafe: true },
    });
    expect(await loopOf(loop.id)).toMatchObject({ status: 'live', consecutiveFailures: 0 });
  });

  it('reopens a released ticket uncounted, and leaves a ticket its owner moved alone', async () => {
    const loop = await createLoop();
    const released = await createTicket(loop.id);
    const moved = await createTicket(loop.id);
    const first = await claim(released.id);
    const second = await claim(moved.id);
    await WorkItem.updateOne({ _id: moved.id }, { $set: { status: 'open', stage: 'todo' } });

    await completeRunnerRun(USER, first.runId, { outcome: 'released', durationMs: 1 }, NOW, logger);
    await completeRunnerRun(USER, second.runId, { outcome: 'advanced', answer: 'x', durationMs: 1 }, NOW, logger);

    expect(await ticketOf(released.id)).toMatchObject({ status: 'open', runCount: 0 });
    expect((await ticketOf(released.id)).executionId).toBeUndefined();
    expect(await runOf(first.runId)).toMatchObject({ status: 'aborted' });
    expect(await ticketOf(moved.id)).toMatchObject({ status: 'open', stage: 'todo' });
    expect(await runOf(second.runId)).toMatchObject({ status: 'completed' });
  });
});

describe('releaseExpiredRunnerLeases', () => {
  it('fails a lapsed run and reopens its ticket, leaving a fresh one and a moved ticket alone', async () => {
    const loop = await createLoop();
    const lapsed = await createTicket(loop.id);
    const fresh = await createTicket(loop.id);
    const moved = await createTicket(loop.id);
    const lapsedRun = await claim(lapsed.id, new Date(NOW.getTime() - 10 * 60_000));
    const freshRun = await claim(fresh.id);
    const movedRun = await claim(moved.id, new Date(NOW.getTime() - 10 * 60_000));
    await WorkItem.updateOne({ _id: moved.id }, { $set: { status: 'blocked', statusReason: 'By hand' } });

    await releaseExpiredRunnerLeases(NOW, logger);

    expect(await ticketOf(lapsed.id)).toMatchObject({ status: 'open', runCount: 1 });
    expect(await runOf(lapsedRun.runId)).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
    expect(await ticketOf(fresh.id)).toMatchObject({ status: 'in_progress' });
    expect(await runOf(freshRun.runId)).toMatchObject({ status: 'running' });
    expect(await ticketOf(moved.id)).toMatchObject({ status: 'blocked', statusReason: 'By hand' });
    expect(await runOf(movedRun.runId)).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
  });
});

describe('resolveLoopRunTag', () => {
  it("credits the caller's own active run toward its loop, and ignores a foreign, unknown or API-key tag", async () => {
    const loop = await createLoop();
    const { runId } = await claim((await createTicket(loop.id)).id);

    expect(await resolveLoopRunTag(runId, USER, false, logger)).toBe(runId);
    expect(await resolveLoopRunTag(runId, 'user-2', false, logger)).toBeUndefined();
    expect(await resolveLoopRunTag(new mongoose.Types.ObjectId().toString(), USER, false, logger)).toBeUndefined();
    expect(await resolveLoopRunTag('not-an-id', USER, false, logger)).toBeUndefined();
    expect(await resolveLoopRunTag(runId, USER, true, logger)).toBeUndefined();

    await agentExecutionRepository.addRunnerCredits(runId, USER, 2.5);
    const today = new Date('2026-11-04T00:00:00Z');
    expect(await agentExecutionRepository.sumCreditsByLoop([loop.id], ['session-1'], today)).toEqual({
      [loop.id]: 2.5,
    });
  });

  it('refuses a call for a run at its credit cap as out of credits', async () => {
    const loop = await createLoop();
    const { runId } = await claim((await createTicket(loop.id)).id);
    await AgentExecution.updateOne({ _id: runId }, { $set: { creditCap: 2, totalCreditsUsed: 2 } });

    await expect(resolveLoopRunTag(runId, USER, false, logger)).rejects.toMatchObject({
      statusCode: 422,
      additionalInfo: { errorCode: 'insufficient_credits' },
    });
  });
});
