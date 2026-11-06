import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { settingsMap } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration, {
  BACKUP_COLLECTION,
  DEAD_SIGNUP_GRANT_SETTING_NAMES,
} from './20260921239996_drop-retired-grant-settings';
import SeedSignupGrantPools from './20260921237500_seed-signup-grant-pools';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await AdminSettings.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await AdminSettings.init();
});

const rows = async () =>
  Object.fromEntries(
    (await AdminSettings.collection.find({}).toArray()).map(row => [row.settingName, row.settingValue])
  );
const backups = () => mongoose.connection.collection(BACKUP_COLLECTION).find({ kind: 'row' }).toArray();

const seed = async () => {
  await AdminSettings.collection.insertMany([
    { settingName: 'defaultFreeCredits', settingValue: '5000' },
    { settingName: 'verifiedUnlockCredits', settingValue: '3000' },
    { settingName: 'signupGrantDailyBudget', settingValue: '0' },
    { settingName: 'stagedSignupGrantEnabled', settingValue: 'true', deleted: true },
    { settingName: 'signupGrantDripCap', settingValue: '3000' },
    { settingName: 'ReferralCreditsAmount', settingValue: '250' },
  ]);
};

describe('drop-retired-grant-settings migration', () => {
  it('targets only names absent from settingsMap', () => {
    expect(DEAD_SIGNUP_GRANT_SETTING_NAMES).toHaveLength(11);
    for (const name of DEAD_SIGNUP_GRANT_SETTING_NAMES) expect(settingsMap, name).not.toHaveProperty(name);
  });

  it('runs after the pool seed that still reads signupGrantDailyBudget', () => {
    expect(migration.id).toBeGreaterThan(SeedSignupGrantPools.id);
  });

  it('backs up and deletes only the dead rows, tombstones included', async () => {
    await seed();
    await migration.up();

    expect(await rows()).toEqual({ signupGrantDripCap: '3000', ReferralCreditsAmount: '250' });
    expect((await backups()).map(b => b.settingName).sort()).toEqual([
      'defaultFreeCredits',
      'signupGrantDailyBudget',
      'stagedSignupGrantEnabled',
      'verifiedUnlockCredits',
    ]);
  });

  it('is idempotent and keeps the backup on a second run', async () => {
    await seed();
    await migration.up();
    await migration.up();

    expect(await rows()).toEqual({ signupGrantDripCap: '3000', ReferralCreditsAmount: '250' });
    expect(await backups()).toHaveLength(4);
  });

  it('does nothing on an empty database', async () => {
    await migration.up();
    expect(await rows()).toEqual({});
    expect(await backups()).toHaveLength(0);
  });

  it('down restores each row with its value, unless the setting was recreated', async () => {
    await seed();
    const before = await AdminSettings.collection.find({}).sort({ settingName: 1 }).toArray();
    await migration.up();
    await AdminSettings.collection.insertOne({ settingName: 'defaultFreeCredits', settingValue: '7' });
    await migration.down();

    const after = await AdminSettings.collection.find({}).sort({ settingName: 1 }).toArray();
    const expected = before.map(row =>
      row.settingName === 'defaultFreeCredits' ? { ...row, _id: expect.anything(), settingValue: '7' } : row
    );
    expect(after).toEqual(expected);
    expect(await backups()).toHaveLength(4);
  });
});
