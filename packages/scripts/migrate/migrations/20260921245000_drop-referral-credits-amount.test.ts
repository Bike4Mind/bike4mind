import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { settingsMap } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration, { RETIRED_SETTING_NAME } from './20260921245000_drop-referral-credits-amount';
import DropRetiredGrantSettings, { BACKUP_COLLECTION } from './20260921239996_drop-retired-grant-settings';

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
    { settingName: 'ReferralCreditsAmount', settingValue: '5000' },
    { settingName: 'ReferralFirstAnswerCredits', settingValue: '100' },
  ]);
};

describe('drop-referral-credits-amount migration', () => {
  it('targets a name absent from settingsMap', () => {
    expect(settingsMap).not.toHaveProperty(RETIRED_SETTING_NAME);
  });

  it('runs after drop-retired-grant-settings, whose backup collection it shares', () => {
    expect(migration.id).toBeGreaterThan(DropRetiredGrantSettings.id);
  });

  it('backs up and deletes only the retired row', async () => {
    await seed();
    await migration.up();

    expect(await rows()).toEqual({ ReferralFirstAnswerCredits: '100' });
    const [backup, ...rest] = await backups();
    expect(rest).toHaveLength(0);
    expect(backup.settingName).toBe('ReferralCreditsAmount');
    expect(backup.row.settingValue).toBe('5000');
  });

  it('deletes a soft-deleted tombstone too', async () => {
    await AdminSettings.collection.insertOne({
      settingName: 'ReferralCreditsAmount',
      settingValue: '5000',
      deletedAt: new Date(),
    });
    await migration.up();

    expect(await rows()).toEqual({});
    expect(await backups()).toHaveLength(1);
  });

  it('is idempotent and keeps the original backup when a rerun finds the key recreated', async () => {
    await seed();
    await migration.up();
    await migration.up();
    expect(await backups()).toHaveLength(1);

    await AdminSettings.collection.insertOne({ settingName: 'ReferralCreditsAmount', settingValue: '7' });
    await migration.up();

    const all = await backups();
    expect(all).toHaveLength(1);
    expect(all[0].row.settingValue).toBe('5000');
    expect(await rows()).not.toHaveProperty('ReferralCreditsAmount');
  });

  it('does nothing on an empty database', async () => {
    await migration.up();
    expect(await rows()).toEqual({});
    expect(await backups()).toHaveLength(0);
  });

  it('down restores the row with its value, unless the setting was recreated', async () => {
    await seed();
    const before = await AdminSettings.collection.find({}).sort({ settingName: 1 }).toArray();
    await migration.up();
    await migration.down();
    expect(await AdminSettings.collection.find({}).sort({ settingName: 1 }).toArray()).toEqual(before);

    await migration.up();
    await AdminSettings.collection.insertOne({ settingName: 'ReferralCreditsAmount', settingValue: '7' });
    await migration.down();
    expect((await rows()).ReferralCreditsAmount).toBe('7');
    expect(await backups()).toHaveLength(1);
  });

  it('is not restored by the earlier migration down that shares its backup collection', async () => {
    await seed();
    await migration.up();
    await DropRetiredGrantSettings.down();

    expect(await rows()).toEqual({ ReferralFirstAnswerCredits: '100' });
  });
});
