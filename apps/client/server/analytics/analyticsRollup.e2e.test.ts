import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsDaily, AnalyticsUserDay, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { rollupDay, runNightlyRollup } from './analyticsRollup';

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
  it('DAU equals the direct distinct count of counted users, with UTC day boundaries', async () => {
    await seedEvent(users.a, `${DAY}T00:00:00.000Z`);
    await seedEvent(users.a, `${DAY}T10:00:00.000Z`, { feature: 'image', model: 'dall-e' });
    await seedEvent(users.b, `${DAY}T23:59:59.999Z`);
    await seedEvent(users.c, '2026-06-02T00:00:00.000Z');
    await seedEvent(users.c, '2026-05-31T23:59:59.999Z');
    for (const key of ['admin', 'staff', 'system', 'synthetic', 'deleted'] as const) {
      await seedEvent(users[key], `${DAY}T12:00:00.000Z`);
    }
    await seedEvent(oid(), `${DAY}T12:00:00.000Z`);
    await seedEvent(users.b, `${DAY}T12:00:00.000Z`, { status: 'error' });

    await rollupDay(DAY, { now: NOW });

    const direct = (await UsageEvent.distinct('userId', {
      status: 'ok',
      createdAt: { $gte: new Date(`${DAY}T00:00:00Z`), $lt: new Date('2026-06-02T00:00:00Z') },
      userId: { $in: [users.a, users.b, users.c].map(String) },
    })) as string[];
    const daily = await AnalyticsDaily.findOne({ day: DAY }).lean();
    expect(daily?.dau).toBe(direct.length);
    expect(daily?.dau).toBe(2);
    expect(daily?.requestsByFeature).toEqual({ chat: 2, image: 1 });
    expect(daily?.requestsByModel).toEqual({ 'gpt-4_1': 2, 'dall-e': 1 });
    expect(daily?.creditsConsumed).toBe(6);
    const rows = await AnalyticsUserDay.find({ day: DAY }).lean();
    expect(rows.map(r => r.userId).sort()).toEqual([String(users.a), String(users.b)].sort());
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
