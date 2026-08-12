import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { SettingScopeLevel } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { ScopedSetting, scopedSettingsRepository } from './ScopedSettingModel';

/**
 * Real-Mongo guard for the scoped-override store (#1660). Hand-mocked repos cannot exercise the unique
 * index or the soft-delete read filter, and the delete-then-recreate collision (blocking review item)
 * is precisely what only a real index catches.
 */
let server: Awaited<ReturnType<typeof createMongoServer>>;

const KEY = 'dataLakeSearchMaxFiles';

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Build the unique partial index before asserting on it; mongoose otherwise defers to background.
  await ScopedSetting.init();
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await ScopedSetting.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

describe('ScopedSettingModel unique index + soft delete', () => {
  it('re-creating an override at an address whose prior row was soft-deleted does NOT throw E11000', async () => {
    const addr = { scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1', settingName: KEY };

    const first = await ScopedSetting.create({ ...addr, settingValue: '1000' });
    // Soft delete routes through the plugin (sets deletedAt; the row stays in the collection).
    await ScopedSetting.deleteOne({ _id: first._id });

    // Without partialFilterExpression: { deletedAt: null }, the tombstone still occupies the key and
    // this insert collides. With it, the tombstone is out of the index and the reset succeeds.
    await expect(ScopedSetting.create({ ...addr, settingValue: '2000' })).resolves.toBeTruthy();

    const live = await scopedSettingsRepository.findOverrides([{ scopeLevel: addr.scopeLevel, scopeId: 'l1' }], [KEY]);
    expect(live).toHaveLength(1);
    expect(live[0].settingValue).toBe('2000');
  });

  it('still rejects two LIVE overrides at the same address', async () => {
    const addr = { scopeLevel: SettingScopeLevel.Owner, scopeId: 'u1', settingName: KEY };
    await ScopedSetting.create({ ...addr, settingValue: '1000' });
    await expect(ScopedSetting.create({ ...addr, settingValue: '2000' })).rejects.toMatchObject({ code: 11000 });
  });

  it('the same setting can be overridden at different rungs concurrently', async () => {
    await ScopedSetting.create({
      scopeLevel: SettingScopeLevel.Organization,
      scopeId: 'o1',
      settingName: KEY,
      settingValue: '3000',
    });
    await ScopedSetting.create({
      scopeLevel: SettingScopeLevel.Owner,
      scopeId: 'o1',
      settingName: KEY,
      settingValue: '2000',
    });
    await ScopedSetting.create({
      scopeLevel: SettingScopeLevel.Lake,
      scopeId: 'l1',
      settingName: KEY,
      settingValue: '1000',
    });

    const rows = await scopedSettingsRepository.findOverrides(
      [
        { scopeLevel: SettingScopeLevel.Organization, scopeId: 'o1' },
        { scopeLevel: SettingScopeLevel.Owner, scopeId: 'o1' },
        { scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1' },
      ],
      [KEY]
    );
    expect(rows).toHaveLength(3);
  });

  it('findOverrides excludes soft-deleted rows', async () => {
    const doc = await ScopedSetting.create({
      scopeLevel: SettingScopeLevel.Lake,
      scopeId: 'l1',
      settingName: KEY,
      settingValue: '1000',
    });
    await ScopedSetting.deleteOne({ _id: doc._id });

    const rows = await scopedSettingsRepository.findOverrides(
      [{ scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1' }],
      [KEY]
    );
    expect(rows).toHaveLength(0);
  });

  it('findOverrides matches only the requested (level,id) x name pairs', async () => {
    await ScopedSetting.create({
      scopeLevel: SettingScopeLevel.Lake,
      scopeId: 'l1',
      settingName: KEY,
      settingValue: '1000',
    });
    await ScopedSetting.create({
      scopeLevel: SettingScopeLevel.Lake,
      scopeId: 'l2',
      settingName: KEY,
      settingValue: '2000',
    });

    const rows = await scopedSettingsRepository.findOverrides(
      [{ scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1' }],
      [KEY]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeId).toBe('l1');
  });
});
