import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings, POOL_SEED_UNMETERED } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import { AvailableMigrations } from './index';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921237500_seed-signup-grant-pools';

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
  await AdminSettings.collection.deleteMany({});
});

const setRaw = (settingName: string, settingValue: unknown) =>
  AdminSettings.collection.insertOne({ settingName, settingValue });

const pools = async () => {
  const rows = await AdminSettings.collection
    .find({ settingName: { $in: ['signupGrantSignupPoolDaily', 'signupGrantTricklePoolDaily'] } })
    .toArray();
  return Object.fromEntries(rows.map(row => [row.settingName, row.settingValue]));
};

describe('seed-signup-grant-pools migration', () => {
  it('sorts after every other signup-grant seed and below the fail-closed backfill', () => {
    const ids = AvailableMigrations.map(m => m.id);
    const signupSeeds = AvailableMigrations.filter(m => m !== migration && /signup/.test(m.name));
    expect(signupSeeds.length).toBeGreaterThan(0);
    for (const seed of signupSeeds) expect(migration.id).toBeGreaterThan(seed.id);
    expect(Math.max(...ids)).toBe(20260922000001);
  });

  it.each([
    ['0', String(POOL_SEED_UNMETERED)],
    ['', String(POOL_SEED_UNMETERED)],
    ['-5', String(POOL_SEED_UNMETERED)],
    ['1.5', String(POOL_SEED_UNMETERED)],
    ['abc', String(POOL_SEED_UNMETERED)],
    ['500', '500'],
    [' 500 ', '500'],
    [750, '750'],
  ])('legacy budget %j seeds both pools with %s', async (legacy, expected) => {
    await setRaw('signupGrantDailyBudget', legacy);
    await migration.up();
    expect(await pools()).toEqual({ signupGrantSignupPoolDaily: expected, signupGrantTricklePoolDaily: expected });
  });

  it('seeds the unmetered constant when the legacy row is missing, and never writes 0', async () => {
    await migration.up();
    const seeded = await pools();
    expect(seeded).toEqual({
      signupGrantSignupPoolDaily: String(POOL_SEED_UNMETERED),
      signupGrantTricklePoolDaily: String(POOL_SEED_UNMETERED),
    });
  });

  it('keeps an operator pool row, leaves the legacy row alone, and is a no-op on rerun', async () => {
    await setRaw('signupGrantDailyBudget', '0');
    await setRaw('signupGrantTricklePoolDaily', '0');
    await migration.up();
    await AdminSettings.collection.updateOne(
      { settingName: 'signupGrantSignupPoolDaily' },
      { $set: { settingValue: '42' } }
    );
    await migration.up();
    await migration.down();
    expect(await pools()).toEqual({ signupGrantSignupPoolDaily: '42', signupGrantTricklePoolDaily: '0' });
    expect(await AdminSettings.collection.countDocuments({ settingName: 'signupGrantSignupPoolDaily' })).toBe(1);
    const legacy = await AdminSettings.collection.findOne({ settingName: 'signupGrantDailyBudget' });
    expect(legacy?.settingValue).toBe('0');
  });
});
