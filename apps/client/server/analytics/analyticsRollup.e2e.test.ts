import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsDaily, AnalyticsUserDay, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { classifyRealSignups, signupVerdictUserIds } from './realSignup';
import { reevaluateRecentSignups, rollupDay, runNightlyRollup } from './analyticsRollup';
import { getAnalyticsOverview, loadLiveDay } from './analyticsOverview';
import { UNCLASSIFIED_SOURCE } from '@bike4mind/common';
import { TIMESERIES_SCAN_LIMIT } from '../users/signupTimeseries';

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

describe('rollupDay', () => {
  it('DAU equals the direct distinct count excluding only admin, staff, system and synthetic users', async () => {
    await seedEvent(users.a, `${DAY}T00:00:00.000Z`);
    await seedEvent(users.a, `${DAY}T10:00:00.000Z`, { feature: 'image', model: 'dall-e' });
    await seedEvent(users.b, `${DAY}T23:59:59.999Z`);
    await seedEvent(users.c, '2026-06-02T00:00:00.000Z');
    await seedEvent(users.c, '2026-05-31T23:59:59.999Z');
    for (const key of ['admin', 'staff', 'system', 'synthetic'] as const) {
      await seedEvent(users[key], `${DAY}T12:00:00.000Z`);
    }
    await seedEvent(users.deleted, `${DAY}T12:00:00.000Z`);
    await seedEvent(oid(), `${DAY}T12:00:00.000Z`);
    await UsageEvent.collection.insertOne({
      requestId: String(oid()),
      userId: 'not-an-object-id',
      ownerId: 'not-an-object-id',
      ownerType: 'User',
      feature: 'chat',
      provider: 'p',
      model: 'm',
      costUsd: 0,
      creditsCharged: 0,
      status: 'ok',
      createdAt: new Date(`${DAY}T12:00:00.000Z`),
    });
    await seedEvent(users.b, `${DAY}T12:00:00.000Z`, { status: 'error' });

    await rollupDay(DAY, { now: NOW });

    const direct = (await UsageEvent.distinct('userId', {
      status: 'ok',
      createdAt: { $gte: new Date(`${DAY}T00:00:00Z`), $lt: new Date('2026-06-02T00:00:00Z') },
      userId: { $nin: ['admin', 'staff', 'system', 'synthetic'].map(k => String(users[k as keyof typeof users])) },
    })) as string[];
    const daily = await AnalyticsDaily.findOne({ day: DAY }).lean();
    expect(daily?.dau).toBe(direct.length);
    expect(daily?.dau).toBe(5);
    expect(daily?.requestsByFeature).toEqual({ chat: 5, image: 1 });
    expect(daily?.requestsByModel).toMatchObject({ 'gpt-4.1': 4, 'dall-e': 1 });
    expect(daily?.requestsBySource).toEqual({ web: 5, [UNCLASSIFIED_SOURCE]: 1 });
    const rows = await AnalyticsUserDay.find({ day: DAY }).lean();
    expect(rows.map(r => r.userId)).toContain(String(users.deleted));
    expect(rows.map(r => r.userId)).toContain('not-an-object-id');
    expect(rows.map(r => r.userId)).not.toContain(String(users.admin));
    expect(rows.find(r => r.userId === String(users.a))).toMatchObject({ requests: 2, features: ['chat', 'image'] });

    const internalIds = ['admin', 'staff', 'system', 'synthetic'].map(k => String(users[k as keyof typeof users]));
    const directInternal = (await UsageEvent.distinct('userId', {
      status: 'ok',
      createdAt: { $gte: new Date(`${DAY}T00:00:00Z`), $lt: new Date('2026-06-02T00:00:00Z') },
      userId: { $in: internalIds },
    })) as string[];
    expect(daily?.internal).toEqual({
      dau: directInternal.length,
      wau: 4,
      mau: 4,
      allWau: 9,
      allMau: 9,
      windowComplete: true,
      userIds: [...internalIds].sort(),
      requestsBySource: { web: 4 },
    });
  });

  it('computes internal WAU and MAU over the window and refreshes later days when an earlier one lands', async () => {
    await seedEvent(users.staff, `${DAY}T10:00:00Z`);
    await seedEvent(users.admin, `${DAY}T11:00:00Z`);
    await seedEvent(users.admin, '2026-05-30T10:00:00Z');
    await seedEvent(users.system, '2026-05-10T10:00:00Z');
    await rollupDay(DAY, { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toMatchObject({ dau: 2, wau: 2, mau: 2 });

    await rollupDay('2026-05-10', { now: NOW });
    await rollupDay('2026-05-30', { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toMatchObject({ dau: 2, wau: 2, mau: 3 });
    expect((await AnalyticsDaily.findOne({ day: '2026-05-30' }).lean())?.internal).toMatchObject({
      dau: 1,
      wau: 1,
      mau: 2,
    });
    // External counts are untouched by internal activity.
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: 0, wau: 0, mau: 0 });
  });

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

  it('counts a user whose flags changed inside the window once in the all-accounts WAU and MAU', async () => {
    await seedEvent(users.b, '2026-05-30T10:00:00Z');
    await rollupDay('2026-05-30', { now: NOW });
    await usersCol().updateOne({ _id: users.b }, { $set: { isAdmin: true } });
    await seedEvent(users.b, `${DAY}T10:00:00Z`);
    await seedEvent(users.a, `${DAY}T11:00:00Z`);
    await rollupDay(DAY, { now: NOW });
    const daily = await AnalyticsDaily.findOne({ day: DAY }).lean();
    expect(daily).toMatchObject({ dau: 1, wau: 2, mau: 2 });
    expect(daily?.internal).toMatchObject({ dau: 1, wau: 1, mau: 1, allWau: 2, allMau: 2 });
  });

  it('marks the internal window incomplete while a row in it predates internal counts', async () => {
    await seedEvent(users.admin, '2026-05-30T10:00:00Z');
    await seedEvent(users.staff, `${DAY}T10:00:00Z`);
    await rollupDay('2026-05-30', { now: NOW });
    await AnalyticsDaily.updateOne({ day: '2026-05-30' }, { $unset: { internal: 1 } });
    await rollupDay(DAY, { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toMatchObject({
      wau: 1,
      windowComplete: false,
    });

    await rollupDay('2026-05-30', { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toMatchObject({
      wau: 2,
      allWau: 2,
      windowComplete: true,
    });
  });

  it('leaves a later row without internal counts alone when refreshing its windows', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`);
    await rollupDay(DAY, { now: NOW });
    await AnalyticsDaily.updateOne({ day: DAY }, { $unset: { internal: 1 } });
    await seedEvent(users.admin, '2026-05-30T10:00:00Z');
    await rollupDay('2026-05-30', { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.internal).toBeUndefined();
  });

  it('DAU counts first-party requests only; API users get their own series; system-only users get no row', async () => {
    const [web, cli, desktop, agent, apiOnly, systemOnly, mixed] = Array.from({ length: 7 }, oid);
    for (const id of [web, cli, desktop, agent, apiOnly, systemOnly, mixed]) await seedUser(id);
    await seedEvent(web, `${DAY}T10:00:00Z`, { source: 'web' });
    await seedEvent(cli, `${DAY}T10:00:00Z`, { source: 'cli' });
    await seedEvent(desktop, `${DAY}T10:00:00Z`, { source: 'desktop' });
    await seedEvent(agent, `${DAY}T10:00:00Z`, { source: 'agent' });
    await seedEvent(apiOnly, `${DAY}T10:00:00Z`, { source: 'api' });
    await seedEvent(systemOnly, `${DAY}T10:00:00Z`, { source: 'system' });
    await seedEvent(mixed, `${DAY}T10:00:00Z`, { source: 'api' });
    await seedEvent(mixed, `${DAY}T11:00:00Z`, { source: 'web' });

    await rollupDay(DAY, { now: NOW });

    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: 5, api: { dau: 2 } });
    const rows = await AnalyticsUserDay.find({ day: DAY }).lean();
    expect(rows.map(r => r.userId)).not.toContain(String(systemOnly));
    expect(rows.find(r => r.userId === String(apiOnly))?.active).toBe(false);
    expect(rows.find(r => r.userId === String(mixed))?.active).toBe(true);
  });

  it('removes internal, banned and AI-held accounts from DAU, the API series and the user-day rows', async () => {
    const cases: Record<string, Record<string, unknown>> = {
      developer: { tags: ['Developer'] },
      persona: { username: 'persona-checkout' },
      banned: { isBanned: true },
      moderated: { isModerated: true },
      reviewPending: { riskScore: { reviewState: 'pending' } },
    };
    const ids = Object.fromEntries(Object.keys(cases).map(key => [key, oid()]));
    for (const [key, extra] of Object.entries(cases)) {
      await seedUser(ids[key], extra);
      await seedEvent(ids[key], `${DAY}T10:00:00Z`, { source: 'web' });
      await seedEvent(ids[key], `${DAY}T11:00:00Z`, { source: 'api' });
    }
    await seedEvent(users.a, `${DAY}T10:00:00Z`);

    await rollupDay(DAY, { now: NOW });

    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: 1, api: { dau: 0 } });
    expect((await AnalyticsUserDay.find({ day: DAY }).lean()).map(r => r.userId)).toEqual([String(users.a)]);
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

  it('WAU and MAU count active days only; API users are in api.wau and api.mau', async () => {
    const [mixedDays, apiOnly, webOnly1, webOnly2] = [oid(), oid(), oid(), oid()];
    for (const id of [mixedDays, apiOnly, webOnly1, webOnly2]) await seedUser(id);
    await seedEvent(webOnly1, '2026-05-31T10:00:00Z', { source: 'web' });
    await seedEvent(webOnly2, '2026-05-31T10:00:00Z', { source: 'web' });
    await seedEvent(mixedDays, '2026-05-31T10:00:00Z', { source: 'api' });
    await seedEvent(mixedDays, `${DAY}T10:00:00Z`, { source: 'web' });
    await seedEvent(apiOnly, '2026-05-31T10:00:00Z', { source: 'api' });
    for (const d of ['2026-05-31', DAY]) await rollupDay(d, { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({
      dau: 1,
      wau: 3,
      mau: 3,
      api: { dau: 0, wau: 2, mau: 2 },
    });
  });

  it('writes a zero row for an empty day', async () => {
    await rollupDay(DAY, { now: NOW });
    const daily = await AnalyticsDaily.findOne({ day: DAY }).lean();
    expect(daily).toMatchObject({ dau: 0, wau: 0, mau: 0 });
    // An empty map must survive the write: readers spread it without a fallback.
    expect(daily?.internal).toMatchObject({ dau: 0, userIds: [], requestsBySource: {} });
  });

  it('computes WAU and MAU from user-day rows ending on the day', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`);
    await seedEvent(users.b, '2026-05-30T10:00:00Z');
    await seedEvent(users.c, '2026-05-01T10:00:00Z');
    for (const d of ['2026-05-01', '2026-05-30', DAY]) await rollupDay(d, { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: 1, wau: 2, mau: 2 });
  });

  it('re-running a day leaves the rows identical and drops users that stopped counting', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`);
    await seedEvent(users.b, `${DAY}T11:00:00Z`);
    await rollupDay(DAY, { now: NOW });
    const strip = (rows: Record<string, unknown>[]) =>
      rows
        .map(({ _id, createdAt, updatedAt, __v, ...rest }) => rest)
        .sort((x, y) => String(x.userId).localeCompare(String(y.userId)));
    const before = strip(await AnalyticsUserDay.find({}).lean());
    const dailyBefore = await AnalyticsDaily.findOne({ day: DAY }).lean();
    await rollupDay(DAY, { now: NOW });
    expect(strip(await AnalyticsUserDay.find({}).lean())).toEqual(before);
    expect(await AnalyticsDaily.countDocuments({})).toBe(1);
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: dailyBefore?.dau });

    await usersCol().updateOne({ _id: users.b }, { $set: { isSynthetic: true } });
    await rollupDay(DAY, { now: NOW });
    expect(await AnalyticsUserDay.countDocuments({ day: DAY })).toBe(1);
  });

  it('stores the rollups in analytics_user_days and analytics_daily', () => {
    expect(AnalyticsUserDay.collection.collectionName).toBe('analytics_user_days');
    expect(AnalyticsDaily.collection.collectionName).toBe('analytics_daily');
  });

  it('refreshes WAU/MAU of later days when an earlier day lands afterwards', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`);
    await seedEvent(users.b, '2026-05-30T10:00:00Z');
    const apiUser = oid();
    await seedUser(apiUser);
    await seedEvent(apiUser, '2026-05-30T10:00:00Z', { source: 'api' });
    await rollupDay(DAY, { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({
      wau: 1,
      mau: 1,
      api: { wau: 0, mau: 0 },
    });
    await rollupDay('2026-05-30', { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({
      dau: 1,
      wau: 2,
      mau: 2,
      api: { wau: 1, mau: 1 },
    });
    await AnalyticsUserDay.deleteMany({});
    await seedEvent(users.c, '2026-05-31T10:00:00Z');
    await rollupDay('2026-05-31', { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ wau: 1, mau: 1 });
  });

  it('flags suspected on rows for later activity days of a suspected signup', async () => {
    const day0 = '2026-05-20';
    const burst = Array.from({ length: 12 }, () => oid());
    for (const [i, id] of burst.entries()) {
      await seedUser(id, {
        email: `x${i}@burst.example.com`,
        createdAt: new Date(`${day0}T09:0${i % 10}:00Z`),
        lastActiveAt: new Date(`${day0}T09:30:00Z`),
        signupMeta: { ip: '10.9.9.9' },
      });
    }
    await seedEvent(burst[0], `${DAY}T10:00:00Z`);
    await rollupDay(DAY, { now: NOW });
    const row = await AnalyticsUserDay.findOne({ userId: String(burst[0]) }).lean();
    const cohort = await AnalyticsDaily.findOne({ day: day0 }).lean();
    // Row verdict agrees with the cohort's own evaluation even though the signup day was never rolled up first.
    expect(row?.suspected).toBe(true);
    expect(cohort).toBeNull();
    await seedEvent(burst[0], '2026-06-02T10:00:00Z');
    await rollupDay('2026-06-02', { now: NOW });
    expect(await AnalyticsUserDay.findOne({ userId: String(burst[0]), day: '2026-06-02' }).lean()).toMatchObject({
      suspected: true,
    });
  });

  it('feeds hourly signup counts to the classifier so a signup spike registers', async () => {
    for (let i = 0; i < 12; i++) {
      await seedUser(oid(), { email: `p${i}@spike${i}.example.net`, createdAt: new Date(`${DAY}T09:${10 + i}:00Z`) });
    }
    await rollupDay(DAY, { now: NOW });
    const daily = await AnalyticsDaily.findOne({ day: DAY }).lean();
    expect(daily?.signups.bySignal.signupSpike).toBe(12);
  });

  it('splits the day signups into real and suspected with nothing unclassified', async () => {
    const real = oid();
    const unverified = oid();
    const idle = oid();
    const at = new Date(`${DAY}T09:00:00Z`);
    await seedUser(real, { createdAt: at, emailVerified: true });
    await seedUser(unverified, { createdAt: at });
    await seedUser(idle, { createdAt: at, emailVerified: true });
    await seedEvent(real, `${DAY}T10:00:00Z`);
    await seedEvent(unverified, `${DAY}T10:00:00Z`);
    await rollupDay(DAY, { now: new Date(`${DAY}T12:00:00Z`) });
    const daily = await AnalyticsDaily.findOne({ day: DAY }).lean();
    expect(daily?.signups).toMatchObject({ legit: 1, suspected: 2, unclassified: 0 });
    expect(await AnalyticsUserDay.findOne({ userId: String(real) }).lean()).toMatchObject({
      signupDay: DAY,
      suspected: false,
    });
    expect(await AnalyticsUserDay.findOne({ userId: String(unverified) }).lean()).toMatchObject({ suspected: true });
  });

  it('only counts a request that is successful, non-system and inside 7 days, and the drill-down agrees with the bars', async () => {
    const at = new Date(`${DAY}T00:00:00Z`);
    const ids = { real: oid(), system: oid(), failed: oid(), late: oid(), unverified: oid(), banned: oid() };
    for (const [key, id] of Object.entries(ids)) {
      await seedUser(id, {
        createdAt: at,
        emailVerified: key !== 'unverified',
        ...(key === 'banned' ? { isBanned: true } : {}),
      });
    }
    await seedEvent(ids.real, '2026-06-07T23:59:00Z');
    await seedEvent(ids.system, `${DAY}T10:00:00Z`, { source: 'system' });
    await seedEvent(ids.failed, `${DAY}T10:00:00Z`, { status: 'error' });
    await seedEvent(ids.late, '2026-06-08T00:00:00Z');
    await seedEvent(ids.unverified, `${DAY}T10:00:00Z`);
    await seedEvent(ids.banned, `${DAY}T10:00:00Z`);

    await rollupDay(DAY, { now: NOW });

    const window = { start: at, end: new Date('2026-06-02T00:00:00Z') };
    const real = await signupVerdictUserIds({ ...window, verdict: 'legit' }, { deadlineMs: 30_000 });
    const suspected = await signupVerdictUserIds({ ...window, verdict: 'suspected' }, { deadlineMs: 30_000 });
    expect(real).toEqual([String(ids.real)]);
    expect(suspected.sort()).toEqual([ids.system, ids.failed, ids.late, ids.unverified, ids.banned].map(String).sort());
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.signups).toMatchObject({ legit: 1, suspected: 5 });
  });

  it('refuses a window holding more accounts than maxUsers, counting every account it scans', async () => {
    const window = [new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z')] as const;
    await expect(classifyRealSignups(...window, { deadlineMs: 30_000, maxUsers: 2 })).rejects.toThrow(
      'More than 2 signups in this window'
    );
    await expect(classifyRealSignups(...window, { deadlineMs: 30_000, maxUsers: 100 })).resolves.toBeDefined();
  });

  it('a request after the signup day flips a suspected signup to real on re-evaluation', async () => {
    const late = oid();
    await seedUser(late, { createdAt: new Date(`${DAY}T09:00:00Z`), emailVerified: true });
    await seedEvent(late, `${DAY}T10:00:00Z`, { status: 'error' });
    await seedEvent(users.a, `${DAY}T10:00:00Z`);
    await rollupDay(DAY, { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.signups).toMatchObject({ legit: 0, suspected: 1 });

    await seedEvent(late, '2026-06-04T10:00:00Z');
    await seedEvent(late, '2026-06-04T11:00:00Z', { source: 'system' });
    await rollupDay('2026-06-04', { now: NOW });
    expect(await AnalyticsUserDay.findOne({ userId: String(late), day: '2026-06-04' }).lean()).toMatchObject({
      suspected: false,
    });
    await reevaluateRecentSignups('2026-06-04', { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.signups).toMatchObject({
      legit: 1,
      suspected: 0,
      unclassified: 0,
    });
  });

  it('rejects a malformed day', async () => {
    await expect(rollupDay('2026-02-30')).rejects.toThrow(/Invalid rollup day/);
  });

  it('keeps distinct model ids intact in the stored breakdown', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`, { model: 'gpt-4.1' });
    await seedEvent(users.a, `${DAY}T11:00:00Z`, { model: 'gpt-4_1' });
    expect(await rollupDay(DAY, { now: NOW })).toMatchObject({ dau: 1 });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.requestsByModel).toEqual({
      'gpt-4.1': 1,
      'gpt-4_1': 1,
    });
  });

  it('stores each org the user worked in with only the usage billed to it', async () => {
    const org = (ownerId: string) => ({ ownerType: 'Organization', ownerId });
    for (let i = 0; i < 3; i++) await seedEvent(users.a, `${DAY}T10:0${i}:00Z`);
    await seedEvent(users.a, `${DAY}T11:00:00Z`, org('acme'));
    await seedEvent(users.a, `${DAY}T12:00:00Z`, { ...org('globex'), creditsCharged: 5 });
    await seedEvent(users.a, `${DAY}T12:30:00Z`, { ...org('globex'), creditsCharged: 5 });
    await rollupDay(DAY, { now: NOW });
    const row = await AnalyticsUserDay.findOne({ userId: String(users.a) }).lean();
    expect(row).toMatchObject({ requests: 6, creditsCharged: 18, orgId: 'globex' });
    expect(row?.orgs).toEqual([
      { orgId: 'globex', requests: 2, creditsCharged: 10, active: true },
      { orgId: 'acme', requests: 1, creditsCharged: 2, active: true },
    ]);
  });

  it('records activity per billed org while retaining API-only org usage', async () => {
    const org = (ownerId: string, source: 'web' | 'api') => ({ ownerType: 'Organization', ownerId, source });
    await seedEvent(users.a, `${DAY}T10:00:00Z`);
    await seedEvent(users.a, `${DAY}T11:00:00Z`, org('api-only', 'api'));
    await seedEvent(users.a, `${DAY}T12:00:00Z`, org('mixed', 'web'));
    await seedEvent(users.a, `${DAY}T13:00:00Z`, org('mixed', 'api'));

    await rollupDay(DAY, { now: NOW });

    const row = await AnalyticsUserDay.findOne({ userId: String(users.a), day: DAY }).lean();
    expect(row).toMatchObject({ active: true, requests: 4, creditsCharged: 8 });
    expect(row?.orgs).toEqual([
      { orgId: 'mixed', requests: 2, creditsCharged: 4, active: true },
      { orgId: 'api-only', requests: 1, creditsCharged: 2, active: false },
    ]);
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({
      dau: 1,
      api: { dau: 1 },
      requestsByFeature: { chat: 4 },
      creditsConsumed: 8,
    });
  });

  it('clears stale organization attribution when a day is recomputed with only personal usage', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`, { ownerType: 'Organization', ownerId: 'organization' });
    await rollupDay(DAY, { now: NOW });
    expect(await AnalyticsUserDay.findOne({ userId: String(users.a) }).lean()).toMatchObject({ orgId: 'organization' });
    await UsageEvent.updateMany({}, { $set: { ownerType: 'User', ownerId: String(users.a) } });
    await rollupDay(DAY, { now: NOW });
    const row = await AnalyticsUserDay.findOne({ userId: String(users.a) }).lean();
    expect(row?.ownerType).toBe('User');
    expect(row?.orgId).toBeUndefined();
    expect(row?.orgs).toEqual([]);
  });

  it('splits signups exactly even when the candidate scan truncates', async () => {
    await usersCol().updateOne({ _id: users.a }, { $set: { createdAt: new Date(`${DAY}T09:00:00Z`) } });
    await usersCol().updateMany(
      { _id: { $in: [users.admin, users.staff, users.system, users.synthetic] } },
      { $set: { createdAt: new Date(`${DAY}T09:00:00Z`) } }
    );
    await AnalyticsUserDay.create({
      day: '2026-06-02',
      userId: String(users.a),
      ownerType: 'User',
      signupDay: DAY,
      suspected: true,
    });
    await usersCol().insertMany(
      Array.from({ length: TIMESERIES_SCAN_LIMIT }, () => ({
        _id: oid(),
        username: String(oid()),
        createdAt: new Date('2026-06-02T10:00:00Z'),
      }))
    );
    const warn = vi.fn();
    await rollupDay(DAY, { now: NOW, logger: { warn } });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.signups).toMatchObject({
      legit: 0,
      suspected: 1,
      unclassified: 0,
    });
    expect(warn).toHaveBeenCalled();
    expect(
      await signupVerdictUserIds(
        { start: new Date(`${DAY}T00:00:00Z`), end: new Date('2026-06-02T00:00:00Z'), verdict: 'suspected' },
        { deadlineMs: 30_000 }
      )
    ).toEqual([String(users.a)]);
    expect(await AnalyticsUserDay.findOne({ userId: String(users.a) }).lean()).toMatchObject({ suspected: true });
  });

  it('decides a signup from verification and activity, not from abuse signals', async () => {
    await usersCol().updateOne(
      { _id: users.a },
      {
        $set: {
          createdAt: new Date(`${DAY}T09:00:00Z`),
          signupMeta: { isDatacenter: true },
        },
      }
    );
    await usersCol().updateOne({ _id: users.a }, { $set: { emailVerified: true } });
    await seedEvent(users.a, '2026-06-03T10:00:00Z', { source: 'api' });
    await rollupDay(DAY, { now: NOW });
    expect((await AnalyticsDaily.findOne({ day: DAY }).lean())?.signups).toMatchObject({
      legit: 1,
      suspected: 0,
    });
  });
});

describe('runNightlyRollup', () => {
  it('rolls up the UTC day before the scheduled time', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`);
    await runNightlyRollup('2026-06-02T04:00:00Z', { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: 1 });
  });

  it('rejects an invalid scheduled time', async () => {
    await expect(runNightlyRollup('bad')).rejects.toThrow(/scheduled event time/);
  });
});
