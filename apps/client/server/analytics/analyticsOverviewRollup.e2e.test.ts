import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsDaily, AnalyticsUserDay, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { signupVerdictUserIds } from './realSignup';
import { rollupDay } from './analyticsRollup';
import { getAnalyticsOverview, loadLiveDay } from './analyticsOverview';
import { UNCLASSIFIED_SOURCE } from '@bike4mind/common';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const originalDomains = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
const DAY = '2026-06-01';
const NOW = new Date('2026-06-05T04:00:00.000Z');

const oid = () => new mongoose.Types.ObjectId();
const users = {
  a: oid(),
  b: oid(),
  c: oid(),
  admin: oid(),
  staff: oid(),
  system: oid(),
  synthetic: oid(),
  deleted: oid(),
};

const usersCol = () => mongoose.connection.collection('users');
const seedUser = (id: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) =>
  usersCol().insertOne({
    _id: id,
    username: String(id),
    email: `${id}@customer.example.com`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  });

const seedEvent = (userId: mongoose.Types.ObjectId, at: string, extra: Record<string, unknown> = {}) =>
  UsageEvent.collection.insertOne({
    requestId: String(oid()),
    userId: String(userId),
    ownerId: String(userId),
    ownerType: 'User',
    feature: 'chat',
    provider: 'p',
    model: 'gpt-4.1',
    costUsd: 0.01,
    creditsCharged: 2,
    status: 'ok',
    source: 'web',
    createdAt: new Date(at),
    ...extra,
  });

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await AnalyticsUserDay.createIndexes();
  await AnalyticsDaily.createIndexes();
  // loadCandidates hints on createdAt, so the real indexes must exist.
  await User.createIndexes();
  await UserApiKey.createIndexes();
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example.com';
});

afterAll(async () => {
  if (originalDomains === undefined) delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
  else process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = originalDomains;
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    UsageEvent.deleteMany({}),
    AnalyticsUserDay.deleteMany({}),
    AnalyticsDaily.deleteMany({}),
    User.deleteMany({}),
    UserApiKey.deleteMany({}),
  ]);
  await seedUser(users.a);
  await seedUser(users.b);
  await seedUser(users.c);
  await seedUser(users.admin, { isAdmin: true });
  await seedUser(users.staff, { email: 'dev@staff.example.com' });
  await seedUser(users.system, { isSystem: true });
  await seedUser(users.synthetic, { isSynthetic: true });
  await seedUser(users.deleted, { deletedAt: new Date('2026-05-01T00:00:00Z') });
});

describe('analyticsOverview live slice against rollupDay', () => {
  it('counts only first-party internal activity while retaining API requests in the surface breakdown', async () => {
    await seedEvent(users.admin, `${DAY}T10:00:00Z`, { source: 'api' });
    await seedEvent(users.system, `${DAY}T10:00:00Z`, { source: 'system' });
    const allAccounts = () =>
      getAnalyticsOverview(
        { range: 'custom', from: DAY, to: DAY, compare: 'off', signups: 'all', accounts: 'all' },
        NOW
      );

    const inactive = { dau: 0, wau: 0, mau: 0, allWau: 0, allMau: 0, requestsBySource: { api: 1 } };
    expect((await loadLiveDay(DAY, NOW)).internal).toMatchObject(inactive);
    await rollupDay(DAY, { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toMatchObject({
      ...inactive,
      userIds: [],
    });
    expect((await allAccounts()).activeUsers.days[0]).toMatchObject({ dau: 0, wau: 0, mau: 0 });

    await seedEvent(users.staff, `${DAY}T11:00:00Z`, { source: 'web' });
    await seedEvent(users.staff, `${DAY}T12:00:00Z`, { source: 'api' });
    await seedEvent(users.synthetic, `${DAY}T11:00:00Z`, { source: undefined });
    const active = {
      dau: 2,
      wau: 2,
      mau: 2,
      allWau: 2,
      allMau: 2,
      requestsBySource: { web: 1, api: 2, [UNCLASSIFIED_SOURCE]: 1 },
    };
    expect((await loadLiveDay(DAY, NOW)).internal).toMatchObject(active);
    await rollupDay(DAY, { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toMatchObject({
      ...active,
      userIds: [users.staff, users.synthetic].map(String).sort(),
    });
    expect((await allAccounts()).activeUsers.days[0]).toMatchObject({ dau: 2, wau: 2, mau: 2 });
  });

  it('excludes banned and AI-held internal accounts from live, rolled-up and all-account activity', async () => {
    const holds = [
      { isBanned: true },
      { isModerated: true },
      { riskScore: { reviewState: 'pending' } },
      { deletion: { scheduledFor: new Date('2026-06-10T09:00:00Z') } },
    ];
    for (const hold of holds) {
      const id = oid();
      await seedUser(id, { isAdmin: true, ...hold });
      await seedEvent(id, `${DAY}T10:00:00Z`);
      await seedEvent(id, `${DAY}T11:00:00Z`, { source: 'api' });
    }
    const internal = { dau: 0, wau: 0, mau: 0, allWau: 0, allMau: 0, requestsBySource: {} };
    expect((await loadLiveDay(DAY, NOW)).internal).toEqual({ ...internal, windowComplete: true });

    await rollupDay(DAY, { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toEqual({
      ...internal,
      windowComplete: true,
      userIds: [],
    });
    const all = await getAnalyticsOverview(
      { range: 'custom', from: DAY, to: DAY, compare: 'off', signups: 'all', accounts: 'all' },
      NOW
    );
    expect(all.activeUsers.days[0]).toMatchObject({ dau: 0, wau: 0, mau: 0 });
  });

  it('excludes accounts scheduled for deletion from live and rolled-up activity and real signups', async () => {
    const held = oid();
    const createdAt = new Date(`${DAY}T09:00:00Z`);
    await seedUser(held, {
      createdAt,
      emailVerified: true,
      deletion: { scheduledFor: new Date('2026-06-10T09:00:00Z') },
    });
    await seedEvent(held, `${DAY}T10:00:00Z`);
    await seedEvent(held, `${DAY}T11:00:00Z`, { source: 'api' });
    await seedEvent(users.a, `${DAY}T10:00:00Z`);

    const live = await loadLiveDay(DAY, NOW);
    expect(live).toMatchObject({ dau: 1, api: { dau: 0 }, signups: { legit: 0, suspected: 1 } });

    await rollupDay(DAY, { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({
      dau: 1,
      api: { dau: 0 },
      signups: { legit: 0, suspected: 1 },
    });
    expect(await AnalyticsUserDay.exists({ userId: String(held) })).toBeNull();
    const window = { start: new Date(`${DAY}T00:00:00Z`), end: new Date('2026-06-02T00:00:00Z') };
    expect(await signupVerdictUserIds({ ...window, verdict: 'legit' }, { deadlineMs: 30_000 })).toEqual([]);
    expect(await signupVerdictUserIds({ ...window, verdict: 'suspected' }, { deadlineMs: 30_000 })).toEqual([
      String(held),
    ]);
  });
});
