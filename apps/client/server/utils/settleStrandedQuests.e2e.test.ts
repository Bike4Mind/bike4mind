import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { agentExecutionRepository, questRepository, Quest, type AgentExecutionStatus } from '@bike4mind/database';
import { settleStrandedQuests } from './settleStrandedQuests';
import { ABANDONED_REPLY } from '@server/chatCompletion/questTimeoutRecovery';

/**
 * The one test that spans the seam this whole path is built on: a real execution
 * terminated by a real sweep, then the real settle pass, against real Mongo.
 *
 * Every caller-side test mocks `questRepository`, and the repository methods are
 * covered on their own in packages/database, so nothing else exercises the
 * CONTRACT between them. That contract has already drifted once here
 * (`cleanupStaleActive` used to resolve a count while callers wanted ids) and
 * neither half's own tests could see it.
 *
 * The two scenarios that matter most are the ones where this fix could do harm
 * rather than good: a run that produced a partial answer, and a run that
 * finished naturally just as the sweep landed. Both must come out untouched.
 *
 * Lives in apps/client because that is where `settleStrandedQuests` lives, and
 * consumes the built dist of @bike4mind/database, so `pnpm turbo:core:build`
 * must be current.
 */

// Boots a real mongod, so lift the whole file off the shard's unit-test budget
// for tests AND hooks (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const STALE_MS = 20 * 60 * 1000;
const logger = { warn: () => {}, error: () => {} };

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const makeExecution = (overrides: Partial<Parameters<typeof agentExecutionRepository.create>[0]> = {}) => ({
  userId: new mongoose.Types.ObjectId().toString(),
  sessionId: new mongoose.Types.ObjectId().toString(),
  questId: new mongoose.Types.ObjectId().toString(),
  query: 'do the thing',
  model: 'test-model',
  status: 'pending' as AgentExecutionStatus,
  approvedTools: [],
  deniedTools: [],
  iterationBilling: [],
  totalCreditsUsed: 0,
  lambdaInvocationCount: 1,
  childExecutionIds: [],
  ...overrides,
});

/**
 * A dispatched run as it exists on disk: an active execution plus the bubble
 * `agentExecute`/`runQuestNode` create for it at dispatch, linked by
 * `agentExecutionId` - the only key the settle pass can follow.
 */
async function dispatch(opts: {
  userId: string;
  status: AgentExecutionStatus;
  quest?: Record<string, unknown>;
  staleBy?: number;
}) {
  const execution = await agentExecutionRepository.create(makeExecution({ userId: opts.userId, status: opts.status }));
  const quest = await questRepository.create({
    sessionId: 'session-a',
    type: 'message',
    timestamp: new Date(),
    prompt: 'do the thing',
    agentExecutionId: execution.id,
    status: 'pending',
    ...opts.quest,
  } as Parameters<typeof questRepository.create>[0]);

  if (opts.staleBy) {
    // `timestamps: false` would be ignored on a raw collection write, which is
    // the point: Mongoose must not refresh the `updatedAt` we are backdating.
    await mongoose
      .model('AgentExecution')
      .collection.updateOne(
        { _id: new mongoose.Types.ObjectId(execution.id) },
        { $set: { updatedAt: new Date(Date.now() - opts.staleBy) } }
      );
  }
  return { execution, quest };
}

const questById = (id: string) => Quest.findById(id).lean();

describe('stranded-quest settling, end to end', () => {
  it('takes a bubble stranded by the reactive sweep from pending to a terminal error', async () => {
    // The reported bug: the execution is dead and the quest still says pending,
    // so the UI spins with no error and nothing to retry.
    const userId = new mongoose.Types.ObjectId().toString();
    const { execution, quest } = await dispatch({
      userId,
      status: 'awaiting_permission',
      staleBy: 60 * 60 * 1000,
    });

    const swept = await agentExecutionRepository.cleanupStaleActive(userId, STALE_MS);
    expect(swept).toEqual([execution.id]);
    // The bubble is still stranded at this point - the sweep alone is the bug.
    expect((await questById(quest.id))?.status).toBe('pending');

    expect(await settleStrandedQuests(swept, logger, '[test]')).toEqual({ settled: 1, failed: false });

    const after = await questById(quest.id);
    expect(after?.status).toBe('done');
    expect(after?.type).toBe('error');
    expect(after?.reply).toBe(ABANDONED_REPLY);
    expect((await agentExecutionRepository.findById(execution.id))?.status).toBe('aborted');
  });

  it('settles the same bubble when the hourly cron is what terminates the run', async () => {
    // Different terminator (`markAbandoned`, writing failed/abandoned rather
    // than aborted), same bubble outcome - the two must not drift.
    const userId = new mongoose.Types.ObjectId().toString();
    const { execution, quest } = await dispatch({ userId, status: 'running' });

    const marked = await agentExecutionRepository.markAbandoned([execution.id]);
    expect(marked.map(m => m.id)).toEqual([execution.id]);

    expect(
      await settleStrandedQuests(
        marked.map(m => m.id),
        logger,
        '[test]'
      )
    ).toEqual({ settled: 1, failed: false });

    expect((await questById(quest.id))?.reply).toBe(ABANDONED_REPLY);
    const after = await agentExecutionRepository.findById(execution.id);
    expect(after?.status).toBe('failed');
    expect(after?.failureReason).toBe('abandoned');
  });

  it('preserves a partial answer instead of replacing it with the error text', async () => {
    // The first way this fix could do harm. The run streamed something before
    // it died; stamping "please try again" over it misreports a partial success
    // as a total failure and destroys the only content the user has.
    const userId = new mongoose.Types.ObjectId().toString();
    const { quest } = await dispatch({
      userId,
      status: 'running',
      quest: { status: 'running', reply: 'here is half an answer' },
      staleBy: 60 * 60 * 1000,
    });

    const swept = await agentExecutionRepository.cleanupStaleActive(userId, STALE_MS);
    expect(await settleStrandedQuests(swept, logger, '[test]')).toEqual({ settled: 1, failed: false });

    const after = await questById(quest.id);
    expect(after?.status).toBe('done');
    expect(after?.reply).toBe('here is half an answer');
    // Only `status` flipped: the bubble is not an error, it is a short answer.
    expect(after?.type).toBe('message');
  });

  it('leaves a run that finished naturally alone, whichever way the race went', async () => {
    // The second way this fix could do harm. `persistRunAsQuest` got there
    // first, so the quest is terminal with the real answer on it and the settle
    // pass must decline it rather than overwrite it.
    const userId = new mongoose.Types.ObjectId().toString();
    const { execution, quest } = await dispatch({
      userId,
      status: 'running',
      quest: { status: 'done', reply: 'the complete answer' },
      staleBy: 60 * 60 * 1000,
    });

    const swept = await agentExecutionRepository.cleanupStaleActive(userId, STALE_MS);
    expect(swept).toEqual([execution.id]);
    expect(await settleStrandedQuests(swept, logger, '[test]')).toEqual({ settled: 0, failed: false });

    const after = await questById(quest.id);
    expect(after?.status).toBe('done');
    expect(after?.reply).toBe('the complete answer');
    expect(after?.type).toBe('message');
  });

  it('does not touch a healthy DAG parent or its bubble', async () => {
    // `awaiting_dag_children` is excluded from the sweep because a healthy
    // parent idles for hours while children work. If that guard ever slips, a
    // live orchestration is auto-aborted AND its bubble is stamped as
    // abandoned, which is the worst outcome on this whole path.
    const userId = new mongoose.Types.ObjectId().toString();
    const { execution, quest } = await dispatch({
      userId,
      status: 'awaiting_dag_children',
      staleBy: 60 * 60 * 1000,
    });

    const swept = await agentExecutionRepository.cleanupStaleActive(userId, STALE_MS);
    expect(swept).toEqual([]);
    expect(await settleStrandedQuests(swept, logger, '[test]')).toEqual({ settled: 0, failed: false });

    expect((await agentExecutionRepository.findById(execution.id))?.status).toBe('awaiting_dag_children');
    expect((await questById(quest.id))?.status).toBe('pending');
  });

  it('settles only the bubbles behind the executions it swept', async () => {
    // One user, two runs: one dead, one live. A filter mistake that widened the
    // match would terminate the live bubble mid-stream.
    const userId = new mongoose.Types.ObjectId().toString();
    const dead = await dispatch({ userId, status: 'running', staleBy: 60 * 60 * 1000 });
    const live = await dispatch({ userId, status: 'running' });

    const swept = await agentExecutionRepository.cleanupStaleActive(userId, STALE_MS);
    expect(swept).toEqual([dead.execution.id]);
    expect(await settleStrandedQuests(swept, logger, '[test]')).toEqual({ settled: 1, failed: false });

    expect((await questById(dead.quest.id))?.status).toBe('done');
    expect((await questById(live.quest.id))?.status).toBe('pending');
    expect((await agentExecutionRepository.findById(live.execution.id))?.status).toBe('running');
  });
});
