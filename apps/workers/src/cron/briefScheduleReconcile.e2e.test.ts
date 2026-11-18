import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AgentExecutionModel,
  AssistantBriefModel,
  User,
  agentExecutionRepository,
  assistantBriefRepository,
  userRepository,
} from '@bike4mind/database';
import { startScheduledBrief } from '@bike4mind/server-utils/briefs/startBriefComposition';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { RETRY_WINDOW_MS, runBriefScheduleReconcile } from './briefScheduleReconcile';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Real clock: the composer stamps createdAt itself and its in-flight check compares against it.
const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const schedule = { enabled: true, timeOfDay: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'America/Los_Angeles' };
let server: Awaited<ReturnType<typeof createMongoServer>>;
const publishCompose = vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  publishCompose.mockClear();
  await Promise.all([
    User.collection.deleteMany({}),
    AssistantBriefModel.collection.deleteMany({}),
    AgentExecutionModel.collection.deleteMany({}),
  ]);
});

const insertUser = async (fields: Record<string, unknown>) =>
  (await User.collection.insertOne({ username: 'u', email: 'u@example.com', ...fields })).insertedId.toString();
const insertRun = (userId: string) =>
  AgentExecutionModel.collection.insertOne({
    userId,
    sessionId: 's1',
    query: 'q',
    status: 'completed',
    createdAt: minutesAgo(60),
  });
const nextBriefAtOf = async (userId: string) => (await userRepository.getBriefSchedule(userId)).nextBriefAt;

const run = () =>
  runBriefScheduleReconcile(
    {
      users: userRepository,
      startScheduledBrief: userId =>
        startScheduledBrief(userId, {
          briefs: assistantBriefRepository,
          users: userRepository,
          hasRunsSince: async (id, since) =>
            (await agentExecutionRepository.findByUserIdPaginated(id, { fromDate: since }, { limit: 1 })).items.length >
            0,
          publishCompose,
          now: () => new Date(),
        }),
      outOfTime: () => false,
    },
    now
  );

describe('runBriefScheduleReconcile', () => {
  it('starts one brief for a due user with activity across two concurrent runs, and advances the slot', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });
    await insertRun(userId);

    const [a, b] = await Promise.all([run(), run()]);

    expect(a.enqueued + b.enqueued).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
    expect(publishCompose).toHaveBeenCalledTimes(1);
    expect(publishCompose).toHaveBeenCalledWith(expect.objectContaining({ userId, scheduled: true }));
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('writes no row for a due user with no activity but still advances the slot', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });

    expect((await run()).no_activity).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('skips a due user with brief pushes off', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: schedule, pushNotifications: { brief_ready: false } },
      nextBriefAt: minutesAgo(2),
    });
    await insertRun(userId);

    expect((await run()).push_off).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
  });

  it('leaves a user whose slot is still ahead untouched', async () => {
    const future = new Date(now.getTime() + 60 * 60_000);
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: future });
    await insertRun(userId);

    expect((await run()).due).toBe(0);
    expect(await nextBriefAtOf(userId)).toEqual(future);
  });

  it('clears the due time of a disabled schedule without starting a brief', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: { ...schedule, enabled: false } },
      nextBriefAt: minutesAgo(2),
    });

    expect((await run()).unscheduled).toBe(1);
    expect(await nextBriefAtOf(userId)).toBeNull();
    expect(publishCompose).not.toHaveBeenCalled();
  });

  it('hands a slot back when the start throws, so the next run starts it', async () => {
    const due = minutesAgo(2);
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: due });
    await insertRun(userId);
    publishCompose.mockRejectedValueOnce(new Error('event bus unavailable'));

    expect((await run()).failed).toBe(1);
    expect(await nextBriefAtOf(userId)).toEqual(due);

    // The first attempt left a composing row; once it is stale the retry goes through.
    await AssistantBriefModel.collection.updateMany({}, { $set: { createdAt: minutesAgo(30) } });
    const retried = await run();
    expect(retried.enqueued).toBe(1);
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('keeps the advanced slot when a start throws past the retry window', async () => {
    const due = new Date(now.getTime() - RETRY_WINDOW_MS - 60_000);
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: due });

    const result = await runBriefScheduleReconcile(
      {
        users: userRepository,
        startScheduledBrief: async () => {
          throw new Error('event bus unavailable');
        },
        outOfTime: () => false,
      },
      now
    );

    expect(result.failed).toBe(1);
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('clears the due time of a stored schedule whose zone cannot be computed, so it stops blocking the batch', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: { ...schedule, timeZone: 'Not/AZone' } },
      nextBriefAt: minutesAgo(2),
    });

    expect((await run()).failed).toBe(1);
    expect(await nextBriefAtOf(userId)).toBeNull();
    expect((await run()).due).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
  });
});
