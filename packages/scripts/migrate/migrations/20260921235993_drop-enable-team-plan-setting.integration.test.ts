import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235993_drop-enable-team-plan-setting';

const DEAD_KEY = 'enableTeamPlan';
const LIVE_KEY = 'teamPlanMinSeats';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the first insert - see createMongoServer's autoIndex note.
  await AdminSettings.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

function raw(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection(name);
}

const adminRow = (settingName: string, settingValue: unknown) => ({ settingName, settingValue, deletedAt: null });

// Raw driver, not the model: without `hardDelete` softDeletePlugin leaves a tombstone, and the model's
// reads hide it - so only a raw count proves the row is actually gone.
describe('drop-enable-team-plan-setting migration (real DB)', () => {
  it('hard-deletes the enableTeamPlan row and leaves a live setting alone', async () => {
    await raw('adminsettings').insertMany([adminRow(DEAD_KEY, true), adminRow(LIVE_KEY, 3)]);

    await migration.up();

    expect(await raw('adminsettings').countDocuments({ settingName: DEAD_KEY })).toBe(0);
    expect(await raw('adminsettings').countDocuments({ settingName: LIVE_KEY })).toBe(1);
  });

  it('is a no-op on re-run', async () => {
    await raw('adminsettings').insertMany([adminRow(DEAD_KEY, true)]);

    await migration.up();
    await migration.up();

    expect(await raw('adminsettings').countDocuments({ settingName: DEAD_KEY })).toBe(0);
  });
});
