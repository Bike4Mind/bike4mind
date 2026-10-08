import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings, ScopedSetting } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235999_unset-stored-default-forced-retrieval-floor';

const KEY = 'forcedRetrievalMinSimilarityPct';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex so the unique keys the fixtures rely on exist before the first insert.
  await AdminSettings.init();
  await ScopedSetting.init();
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

// Raw driver, not the model: these are pre-migration rows, and the platform value is Mixed while the
// overlay one is a String, the two shapes the migration's `isStoredDefault` has to accept.
const adminRow = (settingName: string, settingValue: unknown) => ({ settingName, settingValue, deletedAt: null });
const scopedRow = (settingName: string, settingValue: string, scopeId: string, scopeLevel = 'organization') => ({
  scopeLevel,
  scopeId,
  settingName,
  settingValue,
  deletedAt: null,
});

// Real mongod, not mocks: the point is the raw-driver hard delete (ObjectId ids from `lean()`, the
// softDeletePlugin override) and the soft delete of overlay rows - neither is observable from a mock.
describe('unset-stored-default-forced-retrieval-floor migration (real DB)', () => {
  it('hard-deletes a platform 75 and leaves other keys alone', async () => {
    // A second key also stored at 75, to prove the delete is scoped to this settingName.
    await raw('adminsettings').insertMany([
      adminRow(KEY, 75),
      adminRow('forcedRetrievalRelativeFloorPct', 75),
      adminRow('forcedRetrievalSpreadFloorPct', '60'),
    ]);

    await migration.up();

    expect(await raw('adminsettings').countDocuments({ settingName: KEY })).toBe(0);
    expect(await raw('adminsettings').countDocuments({ settingName: 'forcedRetrievalRelativeFloorPct' })).toBe(1);
    expect(await raw('adminsettings').countDocuments({ settingName: 'forcedRetrievalSpreadFloorPct' })).toBe(1);
  });

  it('soft-deletes stored-75 overlay rows (both spellings) and keeps a non-75 row', async () => {
    await raw('scopedsettings').insertMany([
      scopedRow(KEY, '75', 'org-a'),
      scopedRow(KEY, ' 75', 'org-b'),
      scopedRow(KEY, '60', 'org-c'),
      scopedRow('forcedRetrievalRelativeFloorPct', '75', 'org-d'),
    ]);

    await migration.up();

    // The persisted row is a tombstone (audit trail kept), so it drops out of the resolver's live read.
    const live = await raw('scopedsettings').find({ settingName: KEY, deletedAt: null }).toArray();
    expect(live.map(r => r.settingValue)).toEqual(['60']);
    expect(await raw('scopedsettings').countDocuments({ settingName: KEY, deletedAt: { $ne: null } })).toBe(2);
    // A different key's overlay row is untouched.
    expect(await raw('scopedsettings').countDocuments({ settingName: 'forcedRetrievalRelativeFloorPct' })).toBe(1);
  });

  it('is a no-op on re-run', async () => {
    await raw('adminsettings').insertMany([adminRow(KEY, 75)]);
    await raw('scopedsettings').insertMany([scopedRow(KEY, '75', 'org-a'), scopedRow(KEY, '60', 'org-b')]);

    await migration.up();
    await migration.up();

    expect(await raw('adminsettings').countDocuments({ settingName: KEY })).toBe(0);
    const live = await raw('scopedsettings').find({ settingName: KEY, deletedAt: null }).toArray();
    expect(live.map(r => r.settingValue)).toEqual(['60']);
    expect(await raw('scopedsettings').countDocuments({ settingName: KEY })).toBe(2);
  });

  it('keeps a scoped 75 that shadowed a different platform value', async () => {
    await raw('adminsettings').insertMany([adminRow(KEY, 80)]);
    await raw('scopedsettings').insertMany([scopedRow(KEY, '75', 'org-a'), scopedRow(KEY, '75', 'user-a', 'owner')]);

    await migration.up();

    expect(await raw('adminsettings').countDocuments({ settingName: KEY })).toBe(1);
    const live = await raw('scopedsettings').find({ settingName: KEY, deletedAt: null }).toArray();
    expect(live.map(r => r.scopeId).sort()).toEqual(['org-a', 'user-a']);
  });
});
