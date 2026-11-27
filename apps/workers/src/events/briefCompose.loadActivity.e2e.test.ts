import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AgentExecutionModel,
  AssistantBriefModel,
  EmailTriageItemModel,
  EMAIL_TRIAGE_KINDS,
  Quest,
  Session,
  assistantBriefRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { loadActivity } from './briefCompose';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const userId = new mongoose.Types.ObjectId().toString();
const block = { start: hoursAgo(2), end: hoursAgo(1) };
const reader = { id: userId, groups: [] };
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
    const activity = await loadActivity(brief, now, reader);
    expect(activity.emails.map(item => item.emailId)).toEqual(['inside']);
    expect(activity.runs.map(item => item.query).sort()).toEqual(['inside', 'straddling']);
  });

  it('a regular brief keeps every pending email and is not capped at its end for runs', async () => {
    const brief = await assistantBriefRepository.createComposing({
      userId,
      periodStart: hoursAgo(2.5),
      periodEnd: now,
    });
    const activity = await loadActivity(brief, now, reader);
    expect(activity.emails.map(item => item.emailId).sort()).toEqual(['after', 'before', 'inside']);
    expect(activity.runs.map(item => item.query).sort()).toEqual(['after', 'inside', 'straddling']);
  });
});

describe('loadActivity notebook access', () => {
  const otherUserId = new mongoose.Types.ObjectId().toString();
  const groupId = new mongoose.Types.ObjectId().toString();
  const owned = new mongoose.Types.ObjectId();
  const sharedWithUser = new mongoose.Types.ObjectId();
  const sharedWithGroup = new mongoose.Types.ObjectId();
  const transferred = new mongoose.Types.ObjectId();
  const groupReader = { id: userId, groups: [groupId] };

  beforeEach(async () => {
    await Promise.all([
      AgentExecutionModel.collection.deleteMany({}),
      Session.collection.deleteMany({}),
      Quest.collection.deleteMany({}),
    ]);
    const session = (_id: mongoose.Types.ObjectId, extra: Record<string, unknown>) => ({
      _id,
      name: _id.toString(),
      users: [],
      groups: [],
      ...extra,
    });
    await Session.collection.insertMany([
      session(owned, { userId }),
      session(sharedWithUser, { userId: otherUserId, users: [{ userId, permissions: ['read'] }] }),
      session(sharedWithGroup, { userId: otherUserId, groups: [{ groupId, permissions: ['read'] }] }),
      session(transferred, { userId: otherUserId }),
    ]);
    const ids = [owned, sharedWithUser, sharedWithGroup, transferred].map(id => id.toString());
    await AgentExecutionModel.collection.insertMany(
      ids.map(sessionId => ({
        userId,
        sessionId,
        query: sessionId,
        status: 'completed',
        createdAt: hoursAgo(1),
        completedAt: hoursAgo(0.9),
      }))
    );
    await Quest.collection.insertMany(
      ids.flatMap(sessionId => [
        {
          sessionId,
          timestamp: hoursAgo(0.8),
          reply: `approve in ${sessionId}`,
          deletedAt: null,
          pendingAction: { tool: 'send_reply', ts: now.getTime() - 60_000, params: { sessionId } },
        },
        {
          sessionId,
          timestamp: hoursAgo(0.5),
          reply: `question in ${sessionId}`,
          deletedAt: null,
          suggestedChoices: { options: [{ label: 'Yes' }, { label: 'No' }], selectedIndex: null },
        },
      ])
    );
  });

  it('loads approvals and questions only from notebooks the user can read now', async () => {
    const brief = await assistantBriefRepository.createComposing({ userId, periodStart: hoursAgo(2), periodEnd: now });
    const activity = await loadActivity(brief, now, groupReader);
    const readable = [owned, sharedWithUser, sharedWithGroup].map(id => id.toString()).sort();
    expect(activity.approvals.map(item => item.sessionId).sort()).toEqual(readable);
    expect(activity.questions.map(item => item.sessionId).sort()).toEqual(readable);
  });

  it('loads no notebook activity once every notebook has moved to another owner', async () => {
    await Session.collection.updateMany({}, { $set: { userId: otherUserId, users: [], groups: [] } });
    const brief = await assistantBriefRepository.createComposing({ userId, periodStart: hoursAgo(2), periodEnd: now });
    const activity = await loadActivity(brief, now, groupReader);
    expect(activity.approvals).toEqual([]);
    expect(activity.questions).toEqual([]);
    expect(activity.runs).toHaveLength(4);
  });
});
