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
import { startBlockBrief, type BlockBriefDeps } from './startBriefComposition';

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

const insertUser = async (preferences: object = { busyBlockBrief: { enabled: true } }) => {
  const { insertedId } = await User.collection.insertOne({ username: 'u', email: 'u@example.com', preferences });
  return insertedId.toString();
};

const insertRun = (userId: string, createdAt: Date, completedAt: Date) =>
  AgentExecutionModel.collection.insertOne({
    userId,
    sessionId: 's1',
    query: 'q',
    status: 'completed',
    createdAt,
    completedAt,
  });

const insertEmail = (userId: string, emailId: string, createdAt: Date) =>
  EmailTriageItemModel.collection.insertOne({
    userId,
    emailId,
    kind: EMAIL_TRIAGE_KINDS[0],
    summary: 's',
    briefedAt: null,
    createdAt,
  });

const block = { start: hoursAgo(2), end: hoursAgo(1) };

const makeDeps = () => {
  const publishCompose = vi.fn().mockResolvedValue(undefined);
  const deps: BlockBriefDeps = {
    briefs: assistantBriefRepository,
    runs: agentExecutionRepository,
    users: userRepository,
    hasRunsBetween: async (userId, start, end) =>
      (await agentExecutionRepository.findByUserIdPaginated(userId, { fromDate: start, toDate: end }, { limit: 1 }))
        .items.length > 0,
    notifyHeldRuns: async () => undefined,
    hasEmailsBetween: async (userId, start, end) =>
      (
        await Promise.all(
          EMAIL_TRIAGE_KINDS.map(kind => emailTriageItemRepository.listPending(userId, end, 1, kind, start))
        )
      ).some(items => items.length > 0),
    publishCompose,
    now: () => now,
  };
  return { deps, publishCompose };
};

describe('startBlockBrief', () => {
  it('creates one block brief with the block bounds, widened back to a run that straddles the block start', async () => {
    const userId = await insertUser();
    await insertEmail(userId, 'before', hoursAgo(3));
    await insertEmail(userId, 'inside', hoursAgo(1.5));
    await insertRun(userId, hoursAgo(2.5), hoursAgo(1.8));
    const { deps, publishCompose } = makeDeps();

    expect(await startBlockBrief(userId, block, deps)).toBe('enqueued');
    const rows = await AssistantBriefModel.find({ userId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trigger: 'busy_block',
      busyBlock: block,
      periodStart: hoursAgo(2.5),
      periodEnd: block.end,
    });
    expect(publishCompose).toHaveBeenCalledWith(expect.objectContaining({ userId, scheduled: true }));
  });

  it('starts at the block start when no run straddles it', async () => {
    const userId = await insertUser();
    await insertEmail(userId, 'inside', hoursAgo(1.5));
    const { deps } = makeDeps();

    expect(await startBlockBrief(userId, block, deps)).toBe('enqueued');
    expect(await AssistantBriefModel.findOne({ userId }).lean()).toMatchObject({ periodStart: block.start });
  });

  it('skips a block where only earlier email is pending and nothing ran, leaving no row', async () => {
    const userId = await insertUser();
    await insertEmail(userId, 'before', hoursAgo(3));
    await insertEmail(userId, 'after', hoursAgo(0.5));
    await insertRun(userId, hoursAgo(0.5), hoursAgo(0.4));
    const { deps, publishCompose } = makeDeps();

    expect(await startBlockBrief(userId, block, deps)).toBe('no_activity');
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
  });

  it.each([
    ['busy_off', { busyBlockBrief: { enabled: false } }],
    ['busy_off', {}],
    ['push_off', { busyBlockBrief: { enabled: true }, pushNotifications: { brief_ready: false } }],
  ])('returns %s for preferences %j', async (outcome, preferences) => {
    const userId = await insertUser(preferences);
    await insertEmail(userId, 'inside', hoursAgo(1.5));
    const { deps } = makeDeps();

    expect(await startBlockBrief(userId, block, deps)).toBe(outcome);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
  });

  it('returns user_missing for an unknown user', async () => {
    const { deps } = makeDeps();
    expect(await startBlockBrief(new mongoose.Types.ObjectId().toString(), block, deps)).toBe('user_missing');
  });

  it('a ready block brief does not advance the regular window', async () => {
    const userId = await insertUser();
    await AssistantBriefModel.create({ userId, status: 'ready', periodStart: hoursAgo(30), periodEnd: hoursAgo(24) });
    await AssistantBriefModel.create({
      userId,
      status: 'ready',
      periodStart: block.start,
      periodEnd: block.end,
      trigger: 'busy_block',
      busyBlock: block,
    });
    expect((await assistantBriefRepository.findLatestReady(userId))?.periodEnd).toEqual(hoursAgo(24));
  });
});
