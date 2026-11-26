import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AgentExecutionModel,
  AssistantBriefModel,
  EmailTriageItemModel,
  User,
  agentExecutionRepository,
  assistantBriefRepository,
  emailTriageItemRepository,
  EMAIL_TRIAGE_KINDS,
  userRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import { startScheduledBrief, type ScheduledBriefDeps } from './startBriefComposition';

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
    EmailTriageItemModel.collection.deleteMany({}),
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

const insertRun = (userId: string, createdAt: Date) =>
  AgentExecutionModel.collection.insertOne({ userId, sessionId: 's1', query: 'q', status: 'completed', createdAt });

const insertEmail = (userId: string, createdAt: Date) =>
  EmailTriageItemModel.collection.insertOne({
    userId,
    emailId: `e-${userId}`,
    kind: EMAIL_TRIAGE_KINDS[0],
    summary: 's',
    briefedAt: null,
    createdAt,
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

describe('startScheduledBrief', () => {
  it('enqueues one scheduled brief when the window has agent runs', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('enqueued');
    expect(await AssistantBriefModel.countDocuments({ userId, status: 'composing' })).toBe(1);
    expect(publishCompose).toHaveBeenCalledWith(expect.objectContaining({ userId, scheduled: true }));
  });

  it('enqueues a scheduled brief for pending triaged email even with no agent runs', async () => {
    const userId = await insertUser();
    await insertEmail(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('enqueued');
    expect(publishCompose).toHaveBeenCalledWith(expect.objectContaining({ userId, scheduled: true }));
  });

  it('reports no_activity with no agent runs and no pending email', async () => {
    const userId = await insertUser();
    const { deps, publishCompose } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('no_activity');
    expect(publishCompose).not.toHaveBeenCalled();
  });

  it('writes no row and publishes nothing for an empty window', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(54));
    const { deps, publishCompose } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('no_activity');
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
  });

  it('starts the window at the last ready brief', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    await AssistantBriefModel.collection.insertOne({
      userId,
      status: 'ready',
      periodStart: hoursAgo(16),
      periodEnd: hoursAgo(4),
      createdAt: hoursAgo(4),
    });
    const { deps } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('no_activity');
  });

  it('skips a user whose schedule was disabled after the claim', async () => {
    const userId = await insertUser(undefined, { ...schedule, enabled: false });
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('schedule_off');
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
  });

  it('skips a user who turned brief pushes off', async () => {
    const userId = await insertUser({ brief_ready: false });
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('push_off');
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
  });

  it('does not start a second brief while one is composing', async () => {
    const userId = await insertUser();
    await insertRun(userId, hoursAgo(6));
    const { deps, publishCompose } = makeDeps();

    expect(await startScheduledBrief(userId, deps)).toBe('enqueued');
    expect(await startScheduledBrief(userId, deps)).toBe('in_flight');
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
    expect(publishCompose).toHaveBeenCalledTimes(1);
  });

  it('reports a missing user', async () => {
    const { deps } = makeDeps();
    expect(await startScheduledBrief(new mongoose.Types.ObjectId().toString(), deps)).toBe('user_missing');
  });
});
