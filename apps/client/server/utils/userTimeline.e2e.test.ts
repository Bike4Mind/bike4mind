import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  AdminAuditLogModel,
  CreditTransaction,
  Session,
  UserApiKeyAuditLog,
  UserAuthAuditLogModel,
} from '@bike4mind/database';
import type { AuditLogCursor, UserTimelineEntry, UserTimelineType } from '@bike4mind/common';
import { creditEventsFilter, listUserTimeline, type TimelineRange } from './userTimeline';
import type { ActivitySubject } from './userActivity';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const USER_ID = '650000000000000000000001';
const OTHER_USER_ID = '650000000000000000000009';
const ADMIN_ID = '650000000000000000000002';
const subject: ActivitySubject = { id: USER_ID, name: 'Ada', email: 'ada@example.com', isAdmin: false };

// Whole seconds, so a notebook (second-precision ObjectId time) can tie with rows in other stores.
const T = (second: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, second));
const idAt = (second: number, suffix: string) =>
  new Types.ObjectId(Math.floor(T(second).getTime() / 1000).toString(16) + suffix);

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([CreditTransaction.createIndexes(), Session.createIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Promise.all(
    [AdminAuditLogModel, CreditTransaction, Session, UserApiKeyAuditLog, UserAuthAuditLogModel].map(model =>
      model.collection.deleteMany({})
    )
  );

  // Raw inserts keep each createdAt exactly as written (mongoose timestamps would overwrite it).
  await UserAuthAuditLogModel.collection.insertMany([
    {
      _id: idAt(50, '00000000000000a1'),
      userId: USER_ID,
      event: 'login_success',
      strategy: 'google',
      actorIp: '198.51.100.4',
      userAgent: 'ua',
      createdAt: T(50),
    },
    {
      _id: idAt(30, '00000000000000a2'),
      userId: USER_ID,
      event: 'step_up_failed',
      actorIp: '198.51.100.4',
      userAgent: 'ua',
      createdAt: T(30),
    },
    {
      _id: idAt(10, '00000000000000a3'),
      userId: USER_ID,
      event: 'logout',
      actorIp: '198.51.100.4',
      userAgent: 'ua',
      createdAt: T(10),
    },
    {
      _id: idAt(45, '00000000000000a4'),
      userId: OTHER_USER_ID,
      event: 'login_success',
      actorIp: '203.0.113.1',
      userAgent: 'ua',
      createdAt: T(45),
    },
  ]);
  await UserApiKeyAuditLog.collection.insertMany([
    {
      _id: idAt(40, '00000000000000b1'),
      action: 'mint',
      keyId: 'key-1',
      actorUserId: USER_ID,
      details: { name: 'CI key' },
      createdAt: T(40),
    },
    { _id: idAt(5, '00000000000000b2'), action: 'revoke', keyId: 'key-1', actorUserId: USER_ID, createdAt: T(5) },
  ]);
  await CreditTransaction.collection.insertMany([
    // Same instant as the step_up_failed row: the id decides the order.
    {
      _id: idAt(30, '00000000000000c1'),
      ownerId: USER_ID,
      ownerType: 'User',
      type: 'purchase',
      credits: 5000,
      status: 'completed',
      createdAt: T(30),
    },
    {
      _id: idAt(20, '00000000000000c2'),
      ownerId: USER_ID,
      ownerType: 'User',
      type: 'subscription',
      credits: 10000,
      createdAt: T(20),
    },
    // Usage and admin adjustments never appear as credit events.
    {
      _id: idAt(25, '00000000000000c3'),
      ownerId: USER_ID,
      ownerType: 'User',
      type: 'text_generation_usage',
      credits: -12,
      createdAt: T(25),
    },
    {
      _id: idAt(15, '00000000000000c4'),
      ownerId: USER_ID,
      ownerType: 'User',
      type: 'generic_add',
      reason: 'admin_adjustment',
      credits: 2000,
      createdAt: T(15),
    },
    {
      _id: idAt(35, '00000000000000c5'),
      ownerId: OTHER_USER_ID,
      ownerType: 'User',
      type: 'purchase',
      credits: 1,
      createdAt: T(35),
    },
  ]);
  await Session.collection.insertMany([
    // Ties with the login at T(50); its id is larger, so it sorts first.
    {
      _id: idAt(50, 'ffffffffffffffd1'),
      name: 'Quarterly plan',
      userId: USER_ID,
      lastUpdated: T(50),
      firstCreated: T(50),
      origin: { channel: 'web' },
    },
    {
      _id: idAt(12, '00000000000000d2'),
      name: 'Nightly job',
      userId: USER_ID,
      lastUpdated: T(12),
      firstCreated: T(12),
      origin: { channel: 'agent' },
    },
    {
      _id: idAt(48, '00000000000000d3'),
      name: 'Not theirs',
      userId: OTHER_USER_ID,
      lastUpdated: T(48),
      firstCreated: T(48),
    },
  ]);
  await AdminAuditLogModel.collection.insertMany([
    {
      _id: idAt(15, '00000000000000e1'),
      occurredAt: T(15),
      action: 'user.credits.adjusted',
      category: 'credits',
      severity: 'notice',
      actor: { kind: 'user', scope: 'platform', userId: ADMIN_ID, name: 'Root', wasAdmin: true },
      target: { kind: 'user', id: USER_ID, displayName: 'Ada' },
      summary: 'adjusted credits',
      changes: [{ field: 'currentCredits', before: 100, after: 2100 }],
      context: { source: 'admin_ui' },
    },
  ]);
});

// Newest first, ties broken by id descending.
const EXPECTED = [
  'session:Quarterly plan',
  'signin:login_success',
  'key:mint',
  'credit:purchase',
  'signin:step_up_failed',
  'credit:subscription',
  'admin:user.credits.adjusted',
  'session:Nightly job',
  'signin:logout',
  'key:revoke',
];

const label = (entry: UserTimelineEntry): string => {
  switch (entry.type) {
    case 'usage':
      return `session:${entry.summary.match(/"(.*)"/)?.[1]}`;
    case 'credit':
      return `credit:${entry.transactionType}`;
    case 'signin':
      return `signin:${entry.audit.action.replace('auth.', '')}`;
    case 'key':
      return `key:${entry.audit.action.replace('api_key.', '')}`;
    case 'admin':
      return `admin:${entry.audit.action}`;
  }
};

const ALL: UserTimelineType[] = ['signin', 'usage', 'credit', 'key', 'admin'];

/** Pages to the end (bounded, so a cursor bug fails the test instead of hanging it). */
const readAll = async (types: UserTimelineType[], limit: number, range: TimelineRange = {}) => {
  const seen: UserTimelineEntry[] = [];
  let cursor: AuditLogCursor | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await listUserTimeline(subject, { types, limit, cursor, range });
    expect(result.entries.length).toBeLessThanOrEqual(limit);
    seen.push(...result.entries);
    if (!result.nextCursor) return seen;
    cursor = result.nextCursor;
  }
  throw new Error('timeline did not terminate');
};

describe('listUserTimeline against a real database', () => {
  it('merges every source newest first in one page', async () => {
    const entries = await readAll(ALL, 100);
    expect(entries.map(label)).toEqual(EXPECTED);
  });

  it.each([1, 2, 3, 4])('pages with limit %i to the same order with no gaps or repeats', async limit => {
    const entries = await readAll(ALL, limit);
    expect(entries.map(label)).toEqual(EXPECTED);
  });

  it('filters by source', async () => {
    expect((await readAll(['credit'], 1)).map(label)).toEqual(['credit:purchase', 'credit:subscription']);
    expect((await readAll(['usage', 'key'], 2)).map(label)).toEqual([
      'session:Quarterly plan',
      'key:mint',
      'session:Nightly job',
      'key:revoke',
    ]);
  });

  it('bounds every source by an inclusive date range', async () => {
    const entries = await readAll(ALL, 2, { from: T(15), to: T(40) });
    expect(entries.map(label)).toEqual([
      'key:mint',
      'credit:purchase',
      'signin:step_up_failed',
      'credit:subscription',
      'admin:user.credits.adjusted',
    ]);
  });

  it('summarises entries in plain language', async () => {
    const entries = await readAll(ALL, 100);
    const summaries = Object.fromEntries(entries.map(entry => [label(entry), entry.summary]));
    expect(summaries['signin:login_success']).toBe('Signed in with Google');
    expect(summaries['key:mint']).toBe('Created API key CI key');
    expect(summaries['credit:purchase']).toBe('Bought credits: +5,000 credits');
    expect(summaries['session:Nightly job']).toBe('Agent run started "Nightly job"');
  });

  it('serves credit events from the partial index', async () => {
    const plan = await CreditTransaction.find(creditEventsFilter(USER_ID, { range: {} }))
      .sort({ createdAt: -1, _id: -1 })
      .limit(11)
      .explain('queryPlanner');
    // Scoped to the winning plan so a rejected plan using the index cannot satisfy it.
    const { queryPlanner } = (Array.isArray(plan) ? plan[0] : plan) as { queryPlanner: { winningPlan: unknown } };
    expect(JSON.stringify(queryPlanner.winningPlan)).toContain('credit_tx_owner_balance_events');
  });
});
