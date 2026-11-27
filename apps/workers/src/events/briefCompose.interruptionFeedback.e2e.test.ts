import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { PushNotificationEvent } from '@bike4mind/common';
import {
  AgentExecutionModel,
  AssistantBriefModel,
  AuthSessionModel,
  PushTokenModel,
  User,
  assistantBriefRepository,
  authSessionRepository,
  pushTokenRepository,
  userRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { composeBrief, loadActivity, type BriefComposeDeps } from './briefCompose';
import { deliverPush, loadPushRecipient } from './sendPush';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const block = { start: hoursAgo(2), end: hoursAgo(1) };
let server: Awaited<ReturnType<typeof createMongoServer>>;
let userId: string;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Promise.all(
    [User, AssistantBriefModel, AgentExecutionModel, AuthSessionModel, PushTokenModel].map(model =>
      model.collection.deleteMany({})
    )
  );
  const { insertedId } = await User.collection.insertOne({ username: 'u', email: 'u@example.com', preferences: {} });
  userId = insertedId.toString();
  await AuthSessionModel.create({
    sid: 'sid-1',
    userId,
    refreshTokenHash: 'hash-sid-1',
    createdVia: 'otc',
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  await pushTokenRepository.upsert({
    userId,
    sid: 'sid-1',
    kind: 'device',
    platform: 'ios',
    environment: 'production',
    token: 'tok-a',
  });
});

/** Composes a block brief over one run that finished inside the block, then delivers its push for real. */
async function composeAndDeliver(runStatus: 'completed' | 'failed') {
  await AgentExecutionModel.collection.insertOne({
    userId,
    sessionId: 's1',
    query: 'Summarize the vendor thread',
    status: runStatus,
    createdAt: hoursAgo(1.5),
    completedAt: hoursAgo(1.2),
  });
  const brief = await assistantBriefRepository.createComposing({
    userId,
    periodStart: block.start,
    periodEnd: block.end,
    trigger: 'busy_block',
    busyBlock: block,
  });
  const briefId = brief._id.toString();
  const pushed: PushNotificationEvent[] = [];
  const deps: BriefComposeDeps = {
    now: () => now,
    users: userRepository,
    briefs: assistantBriefRepository,
    loadActivity,
    canCompose: async () => 'ok',
    complete: async () => JSON.stringify({ headline: 'An agent run finished.', happened: ['Run finished.'] }),
    loadInstructions: async () => [],
    push: async event => {
      pushed.push(event);
    },
    notifyHeldRuns: vi.fn(async () => undefined),
    emails: { markBriefed: async () => 0, storedEmailIds: async (_userId, ids) => ids },
    delegations: { markBriefed: async () => 0 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  await composeBrief(deps, { briefId, userId, scheduled: true });

  expect(pushed).toHaveLength(1);
  const send = vi.fn(async () => ({ status: 200 }));
  const result = await deliverPush(
    pushed[0],
    {
      tokens: pushTokenRepository,
      sessions: authSessionRepository,
      loadRecipient: loadPushRecipient,
      transport: { send, close: vi.fn() },
      topic: 'com.example.client',
    },
    { info: vi.fn(), warn: vi.fn() }
  );
  const stored = await assistantBriefRepository.findById(briefId);
  return { event: pushed[0], result, send, status: stored?.status };
}

describe('block-end push with stored interruption feedback', () => {
  it('holds the push for a taught category and leaves the brief ready', async () => {
    await userRepository.setInterruptionFeedback(userId, { agent_completed: true });
    const { event, result, send, status } = await composeAndDeliver('completed');
    expect(event.blockEndCategories).toEqual(['agent_completed']);
    expect(result).toEqual({ status: 'skipped', reason: 'interruption_feedback_hold' });
    expect(send).not.toHaveBeenCalled();
    expect(status).toBe('ready');
  });

  it('delivers when no feedback is stored', async () => {
    const { result, send } = await composeAndDeliver('completed');
    expect(result).toMatchObject({ status: 'sent', delivered: 1 });
    expect(send).toHaveBeenCalledOnce();
  });

  it('delivers when only another category was taught', async () => {
    await userRepository.setInterruptionFeedback(userId, { agent_completed: true });
    const { event, result } = await composeAndDeliver('failed');
    expect(event.blockEndCategories).toEqual(['agent_failed']);
    expect(result).toMatchObject({ status: 'sent', delivered: 1 });
  });
});
