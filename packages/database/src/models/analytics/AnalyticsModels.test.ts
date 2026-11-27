import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMongoServer } from '../../__test__/createMongoServer';
import { AnalyticsUserDay } from './AnalyticsUserDayModel';
import { AnalyticsDaily, analyticsDailyRepository } from './AnalyticsDailyModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await AnalyticsUserDay.createIndexes();
  await AnalyticsDaily.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await AnalyticsUserDay.deleteMany({});
  await AnalyticsDaily.deleteMany({});
});

const userDay = (over: Record<string, unknown> = {}) => ({
  day: '2026-06-01',
  userId: 'u1',
  ownerType: 'User',
  requests: 1,
  creditsCharged: 2,
  suspected: false,
  ...over,
});

describe('AnalyticsUserDay', () => {
  it('rejects a duplicate (day, userId)', async () => {
    await AnalyticsUserDay.create(userDay());
    await expect(AnalyticsUserDay.create(userDay())).rejects.toThrow(/duplicate key/);
  });

  it('upsert keyed on (day, userId) is idempotent', async () => {
    for (let i = 0; i < 2; i++) {
      await AnalyticsUserDay.updateOne({ day: '2026-06-01', userId: 'u1' }, { $set: userDay() }, { upsert: true });
    }
    expect(await AnalyticsUserDay.countDocuments({})).toBe(1);
  });

  it('rejects a malformed day', async () => {
    await expect(AnalyticsUserDay.create(userDay({ day: '2026-6-1' }))).rejects.toThrow(/day/);
  });

  it('declares the planned indexes', async () => {
    const keys = (await AnalyticsUserDay.collection.listIndexes().toArray()).map(i => JSON.stringify(i.key));
    expect(keys).toContain(JSON.stringify({ day: 1, userId: 1 }));
    expect(keys).toContain(JSON.stringify({ userId: 1, day: 1 }));
    expect(keys).toContain(JSON.stringify({ signupDay: 1, day: 1 }));
  });

  it('createIndexes is a no-op on a collection with rows', async () => {
    await AnalyticsUserDay.create(userDay());
    await AnalyticsUserDay.createIndexes();
    await AnalyticsUserDay.createIndexes();
    expect(await AnalyticsUserDay.countDocuments({})).toBe(1);
  });
});

describe('AnalyticsDaily', () => {
  const data = {
    signups: { legit: 1, suspected: 0, unclassified: 2, bySignal: { a: 1 } },
    dau: 3,
    wau: 4,
    mau: 5,
    requestsByFeature: { chat: 3 },
    requestsBySource: {},
    requestsByModel: {},
    creditsConsumed: 0,
    computedAt: new Date('2026-06-02T04:00:00Z'),
  };

  it('upsertDay is idempotent and keeps a zero-value row', async () => {
    await analyticsDailyRepository.upsertDay('2026-06-01', { ...data, dau: 0 });
    await analyticsDailyRepository.upsertDay('2026-06-01', { ...data, dau: 0 });
    const rows = await AnalyticsDaily.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].dau).toBe(0);
  });

  it('rejects a duplicate day', async () => {
    await AnalyticsDaily.create({ ...data, day: '2026-06-01' });
    await expect(AnalyticsDaily.create({ ...data, day: '2026-06-01' })).rejects.toThrow(/duplicate key/);
  });
});

describe('index declarations', () => {
  it.each(['AnalyticsUserDayModel.ts', 'AnalyticsDailyModel.ts'])('%s never uses index: true', file => {
    expect(readFileSync(join(__dirname, file), 'utf8')).not.toMatch(/index:\s*true/);
  });
});
