import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsDaily, AnalyticsUserDay, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { rollupDay, runNightlyRollup } from './analyticsRollup';
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
  });

  it('writes a zero row for an empty day', async () => {
    await rollupDay(DAY, { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: 0, wau: 0, mau: 0 });
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
    await rollupDay(DAY, { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ wau: 1, mau: 1 });
    await rollupDay('2026-05-30', { now: NOW });
    expect(await AnalyticsDaily.findOne({ day: DAY }).lean()).toMatchObject({ dau: 1, wau: 2, mau: 2 });
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

  it('counts accounts that signed up on the day and never calls an unevaluable one legit', async () => {
    const fresh = oid();
    await seedUser(fresh, { createdAt: new Date(`${DAY}T09:00:00Z`) });
    await seedEvent(fresh, `${DAY}T10:00:00Z`);
    await rollupDay(DAY, { now: new Date(`${DAY}T12:00:00Z`) });
    const daily = await AnalyticsDaily.findOne({ day: DAY }).lean();
    expect(daily?.signups.legit).toBe(0);
    expect(daily?.signups.unclassified).toBe(1);
    expect(await AnalyticsUserDay.findOne({ userId: String(fresh) }).lean()).toMatchObject({ signupDay: DAY });
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

  it('clears stale organization attribution when a day is recomputed with only personal usage', async () => {
    await seedEvent(users.a, `${DAY}T10:00:00Z`, { ownerType: 'Organization', ownerId: 'organization' });
    await rollupDay(DAY, { now: NOW });
    expect(await AnalyticsUserDay.findOne({ userId: String(users.a) }).lean()).toMatchObject({ orgId: 'organization' });
    await UsageEvent.updateMany({}, { $set: { ownerType: 'User', ownerId: String(users.a) } });
    await rollupDay(DAY, { now: NOW });
    const row = await AnalyticsUserDay.findOne({ userId: String(users.a) }).lean();
    expect(row?.ownerType).toBe('User');
    expect(row?.orgId).toBeUndefined();
  });

  it('counts signups outside the scan cap as unclassified and preserves their existing verdict', async () => {
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
      suspected: 0,
      unclassified: 1,
    });
    expect(warn).toHaveBeenCalled();
    expect(await AnalyticsUserDay.findOne({ userId: String(users.a) }).lean()).toMatchObject({ suspected: true });
  });

  it('uses API activity from keys created after the signup scan window', async () => {
    await usersCol().updateOne(
      { _id: users.a },
      {
        $set: {
          createdAt: new Date(`${DAY}T09:00:00Z`),
          signupMeta: { isDatacenter: true },
        },
      }
    );
    await UserApiKey.collection.insertOne({
      userId: String(users.a),
      keyPrefix: String(oid()),
      createdAt: new Date('2026-06-04T10:00:00Z'),
      lastUsedAt: new Date('2026-06-04T11:00:00Z'),
    });
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
