import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AgentExecutionModel,
  AssistantBriefModel,
  User,
  agentExecutionRepository,
  assistantBriefRepository,
  emailTriageItemRepository,
  EMAIL_TRIAGE_KINDS,
  userRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import { BriefComposeRejectedError } from './publishBriefCompose';
import { startEventBrief, startScheduledBrief, type ScheduledBriefDeps } from './startBriefComposition';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Real clock: createComposing stamps createdAt itself, and findActiveComposing compares against it.
const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.collection.deleteMany({}),
    AssistantBriefModel.collection.deleteMany({}),
    AgentExecutionModel.collection.deleteMany({}),
  ]);
});

const schedule = { enabled: true, timeOfDay: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'America/Los_Angeles' };

const insertUser = async (pushNotifications?: Record<string, boolean>, briefSchedule: object = schedule) => {
  const { insertedId } = await User.collection.insertOne({
    username: 'u',
    email: 'u@example.com',
    preferences: { briefSchedule, ...(pushNotifications ? { pushNotifications } : {}) },
  });
  return insertedId.toString();
};

const insertRun = (userId: string, createdAt: Date, completedAt?: Date) =>
  AgentExecutionModel.collection.insertOne({
    userId,
    sessionId: 's1',
    query: 'q',
    status: 'completed',
    createdAt,
    ...(completedAt ? { completedAt } : {}),
  });

const makeDeps = () => {
  const publishCompose = vi.fn().mockResolvedValue(undefined);
  const deps: ScheduledBriefDeps = {
    briefs: assistantBriefRepository,
    runs: agentExecutionRepository,
    users: userRepository,
    hasRunsSince: async (userId, since) =>
      (await agentExecutionRepository.findByUserIdPaginated(userId, { fromDate: since }, { limit: 1 })).items.length >
      0,
    hasDueReminders: async (id, now) => (await assistantBriefRepository.findDueReminders(id, now, 1)).length > 0,
    hasPendingEmails: async (userId, end) =>
      (
        await Promise.all(EMAIL_TRIAGE_KINDS.map(kind => emailTriageItemRepository.listPending(userId, end, 1, kind)))
      ).some(items => items.length > 0),
    publishCompose,
    now: () => now,
  };
  return { deps, publishCompose };
};

const lastStartOf = async (userId: string) =>
  (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }))?.lastBriefStartedAt;

describe('startEventBrief', () => {
  it('starts one brief when an event and the schedule race for the same user', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();

    const outcomes = await Promise.all([startEventBrief(userId, deps), startScheduledBrief(userId, deps)]);

    expect(outcomes.filter(o => o === 'enqueued')).toHaveLength(1);
    expect(outcomes.filter(o => o !== 'enqueued')[0]).toMatch(/^(debounced|in_flight)$/);
    expect(await AssistantBriefModel.countDocuments({ userId, status: 'composing' })).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
    expect(publishCompose).toHaveBeenCalledTimes(1);
    expect(publishCompose).toHaveBeenCalledWith(expect.objectContaining({ userId, scheduled: true }));
  });

  it('debounces an event after a scheduled brief finished, even with new activity', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();
    expect(await startScheduledBrief(userId, deps)).toBe('enqueued');

    await AssistantBriefModel.collection.updateOne(
      { userId, status: 'composing' },
      { $set: { status: 'ready', periodEnd: hoursAgo(1) } }
    );
    await insertRun(userId, hoursAgo(0.5));

    expect(await startEventBrief(userId, deps)).toBe('debounced');
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
    expect(publishCompose).toHaveBeenCalledTimes(1);
  });

  it('reports a run that started before the last brief ended and finished after it', async () => {
    const userId = await insertUser();
    const runCreated = hoursAgo(3);
    await insertRun(userId, runCreated, hoursAgo(0.5));
    await AssistantBriefModel.collection.insertOne({
      userId,
      status: 'ready',
      periodStart: hoursAgo(24),
      periodEnd: hoursAgo(2),
      createdAt: hoursAgo(2),
    });
    const { deps } = makeDeps();

    expect(await startEventBrief(userId, deps)).toBe('enqueued');
    const composing = await AssistantBriefModel.findOne({ userId, status: 'composing' }).lean();
    expect(composing?.periodStart).toEqual(runCreated);
  });

  it('lets the scheduled slot run after an earlier event brief, but still debounces a second event', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { lastBriefStartedAt: hoursAgo(1) } }
    );
    const { deps } = makeDeps();

    expect(await startEventBrief(userId, deps)).toBe('debounced');
    expect(await startScheduledBrief(userId, deps)).toBe('enqueued');
    expect(await lastStartOf(userId)).toEqual(now);
  });

  it.each([
    ['schedule_off', undefined, { ...schedule, enabled: false }],
    ['push_off', { brief_ready: false }, schedule],
  ] as const)('writes no row and takes no claim when %s', async (outcome, pushNotifications, briefSchedule) => {
    const userId = await insertUser(pushNotifications, briefSchedule);
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();

    expect(await startEventBrief(userId, deps)).toBe(outcome);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
    expect(await lastStartOf(userId)).toBeUndefined();
  });

  it('gives the claim back after a definitive rejection, so the next start runs', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();
    publishCompose.mockRejectedValueOnce(new BriefComposeRejectedError());

    await expect(startEventBrief(userId, deps)).rejects.toMatchObject({ retrySafe: true });
    expect(await lastStartOf(userId)).toBeUndefined();
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(await startScheduledBrief(userId, deps)).toBe('enqueued');
  });

  it('keeps the claim when the compose event may have been delivered', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();
    publishCompose.mockRejectedValueOnce(new Error('response lost'));

    await expect(startEventBrief(userId, deps)).rejects.toMatchObject({ retrySafe: false });
    expect(await lastStartOf(userId)).toEqual(now);
    expect(await AssistantBriefModel.countDocuments({ userId, status: 'composing' })).toBe(1);
  });
});
