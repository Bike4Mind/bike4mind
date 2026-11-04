import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings, POOL_SEED_UNMETERED, SignupGrantBudgetDayModel } from '@bike4mind/database';
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
  await SignupGrantBudgetDayModel.collection.deleteMany({});
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
    ['0', String(POOL_SEED_UNMETERED), String(POOL_SEED_UNMETERED)],
    ['', String(POOL_SEED_UNMETERED), String(POOL_SEED_UNMETERED)],
    ['-5', String(POOL_SEED_UNMETERED), String(POOL_SEED_UNMETERED)],
    ['1.5', String(POOL_SEED_UNMETERED), String(POOL_SEED_UNMETERED)],
    ['abc', String(POOL_SEED_UNMETERED), String(POOL_SEED_UNMETERED)],
    ['500', '250', '250'],
    [' 501 ', '251', '250'],
    [750, '375', '375'],
    ['2', '1', '1'],
  ])('legacy budget %j seeds signup %s and trickle %s', async (legacy, signup, trickle) => {
    await setRaw('signupGrantDailyBudget', legacy);
    await migration.up();
    expect(await pools()).toEqual({ signupGrantSignupPoolDaily: signup, signupGrantTricklePoolDaily: trickle });
  });

  it('never seeds more than the legacy cap in total, and never a 0 row', async () => {
    for (const legacy of [1, 2, 3, 7, 1000, 1001]) {
      await AdminSettings.collection.deleteMany({});
      await setRaw('signupGrantDailyBudget', String(legacy));
      await migration.up();
      const seeded = Object.values(await pools()).map(Number);
      expect(seeded.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(legacy);
      expect(seeded.every(value => value > 0)).toBe(true);
    }
  });

  it('seeds only the signup pool from a legacy cap of 1, leaving the trickle pool paused', async () => {
    await setRaw('signupGrantDailyBudget', '1');
    await migration.up();
    expect(await pools()).toEqual({ signupGrantSignupPoolDaily: '1' });
  });

  it('seeds the unmetered constant when the legacy row is missing, and never writes 0', async () => {
    await migration.up();
    const seeded = await pools();
    expect(seeded).toEqual({
      signupGrantSignupPoolDaily: String(POOL_SEED_UNMETERED),
      signupGrantTricklePoolDaily: String(POOL_SEED_UNMETERED),
    });
  });

  it("carries today's spend on the retired counter onto the pools, signup first, keeping larger pool spend", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await setRaw('signupGrantDailyBudget', '500');
    await SignupGrantBudgetDayModel.collection.insertMany([
      { _id: day, spent: 300, reservedIds: [] },
      { _id: '2000-01-01', spent: 400, reservedIds: [] },
    ]);
    await migration.up();
    const spent = async (id: string) => (await SignupGrantBudgetDayModel.findById(id).lean())?.spent ?? 0;
    expect([await spent(`signup:${day}`), await spent(`trickle:${day}`)]).toEqual([250, 50]);
    expect(await spent('signup:2000-01-01')).toBe(0);

    await SignupGrantBudgetDayModel.updateOne({ _id: `trickle:${day}` }, { $set: { spent: 120 } });
    await migration.up();
    expect([await spent(`signup:${day}`), await spent(`trickle:${day}`)]).toEqual([250, 120]);
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
