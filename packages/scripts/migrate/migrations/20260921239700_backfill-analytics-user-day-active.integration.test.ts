import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AnalyticsUserDay } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921239600_backfill-analytics-user-day-active';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
  await AnalyticsUserDay.collection.deleteMany({});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const legacyRow = (userId: string, sources?: string[]) => ({
  day: '2026-06-01',
  userId,
  requests: 1,
  credits: 0,
  features: [],
  byOwner: [],
  suspected: false,
  ...(sources ? { sources } : {}),
});

const activeOf = async (userId: string) => (await AnalyticsUserDay.collection.findOne({ userId }))?.active;

describe('backfill analytics user day active', () => {
  it('marks first-party and sourceless rows active, api-only and system-only rows inactive', async () => {
    await AnalyticsUserDay.collection.insertMany([
      legacyRow('web', ['web']),
      legacyRow('mixed', ['api', 'cli']),
      legacyRow('empty', []),
      legacyRow('missing'),
      legacyRow('api', ['api']),
      legacyRow('system', ['system']),
    ]);

    await migration.up();

    expect(await activeOf('web')).toBe(true);
    expect(await activeOf('mixed')).toBe(true);
    expect(await activeOf('empty')).toBe(true);
    expect(await activeOf('missing')).toBe(true);
    expect(await activeOf('api')).toBe(false);
    expect(await activeOf('system')).toBe(false);
  });

  it('leaves rows that already carry the flag alone', async () => {
    await AnalyticsUserDay.collection.insertOne({ ...legacyRow('held', ['web']), active: false });

    await migration.up();

    expect(await activeOf('held')).toBe(false);
  });

  it('builds the active-window index', async () => {
    await migration.up();

    const keys = (await AnalyticsUserDay.collection.indexes()).map(index => index.key);
    expect(keys).toContainEqual({ day: 1, active: 1, userId: 1 });
  });
});
