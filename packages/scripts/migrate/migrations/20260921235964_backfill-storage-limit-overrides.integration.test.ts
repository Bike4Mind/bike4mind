import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235964_backfill-storage-limit-overrides';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>> | undefined;
const users = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');
  return db.collection('users');
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await users().deleteMany({});
});

describe('backfill storage limit overrides', () => {
  it('preserves nondefault limits, marks defaults and leaves existing overrides untouched', async () => {
    await users().insertMany([
      { username: 'custom', storageLimit: 2500, currentStorageSize: 9_000_000_000 },
      { username: 'zero', storageLimit: 0 },
      { username: 'default', storageLimit: 1000 },
      { username: 'missing' },
      { username: 'explicit', storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 },
    ]);
    await migration.up();
    await migration.up();
    const rows = await users().find().sort({ username: 1 }).toArray();
    expect(rows.map(({ username, storageLimitOverride }) => [username, storageLimitOverride])).toEqual([
      ['custom', 2500],
      ['default', null],
      ['explicit', null],
      ['missing', null],
      ['zero', 0],
    ]);
    expect(rows[0]).toMatchObject({ storageLimit: 2500, currentStorageSize: 9_000_000_000 });
    expect(rows[2]).toMatchObject({ storageLimit: 5000, planStorageLimit: 5000 });
  });
});
