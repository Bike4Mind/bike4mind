import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AgentExecutionModel,
  AssistantBriefModel,
  EmailTriageItemModel,
  EMAIL_TRIAGE_KINDS,
  assistantBriefRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { loadActivity } from './briefCompose';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const userId = new mongoose.Types.ObjectId().toString();
const block = { start: hoursAgo(2), end: hoursAgo(1) };
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
    AssistantBriefModel.collection.deleteMany({}),
    AgentExecutionModel.collection.deleteMany({}),
    EmailTriageItemModel.collection.deleteMany({}),
  ]);
  const email = (emailId: string, createdAt: Date) => ({
    userId,
    emailId,
    kind: EMAIL_TRIAGE_KINDS[0],
    summary: emailId,
    briefedAt: null,
    createdAt,
  });
  await EmailTriageItemModel.collection.insertMany([
    email('before', hoursAgo(3)),
    email('inside', hoursAgo(1.5)),
    email('after', hoursAgo(0.5)),
  ]);
  const run = (query: string, createdAt: Date, completedAt: Date) => ({
    userId,
    sessionId: 's1',
    query,
    status: 'completed',
    createdAt,
    completedAt,
  });
  await AgentExecutionModel.collection.insertMany([
    run('straddling', hoursAgo(2.5), hoursAgo(1.8)),
    run('inside', hoursAgo(1.5), hoursAgo(1.2)),
    run('after', hoursAgo(0.5), hoursAgo(0.4)),
  ]);
});

describe('loadActivity windowing', () => {
  it('a block brief lists only email that arrived in the block and runs up to its end', async () => {
    const brief = await assistantBriefRepository.createComposing({
      userId,
      periodStart: hoursAgo(2.5),
      periodEnd: block.end,
      trigger: 'busy_block',
      busyBlock: block,
    });
    const activity = await loadActivity(brief, now);
    expect(activity.emails.map(item => item.emailId)).toEqual(['inside']);
    expect(activity.runs.map(item => item.query).sort()).toEqual(['inside', 'straddling']);
  });

  it('a regular brief keeps every pending email and is not capped at its end for runs', async () => {
    const brief = await assistantBriefRepository.createComposing({
      userId,
      periodStart: hoursAgo(2.5),
      periodEnd: now,
    });
    const activity = await loadActivity(brief, now);
    expect(activity.emails.map(item => item.emailId).sort()).toEqual(['after', 'before', 'inside']);
    expect(activity.runs.map(item => item.query).sort()).toEqual(['after', 'inside', 'straddling']);
  });
});
