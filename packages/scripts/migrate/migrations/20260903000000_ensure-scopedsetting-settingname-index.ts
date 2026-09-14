import { ScopedSetting } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ settingName: 1 }` exists on scopedsettings.
 *
 * `ScopedSettingModel.ts` now declares it for `findBySettingName` (#2157) - the by-setting read a
 * GLOBAL consumer needs, which cannot ride the collection's unique index because `settingName` is
 * that key's LAST field rather than a prefix. Relying on the schema declaration alone means
 * autoIndex builds it lazily on a cold boot of whichever Lambda touches the collection first, and
 * the failure mode until then is the quiet kind: the query returns correct results and
 * collection-scans, so the index added for performance is absent exactly where performance
 * mattered and nothing errors. Same rationale as 20260814000001_ensure-fabfile-userid-tagname-index
 * and 20260820000000_ensure-lakeaccessevent-questid-index.
 *
 * A plain index, not sparse or partial: `settingName` is required on every row, and the caller
 * wants live and tombstoned rows discriminated by the `deletedAt: null` filter softDeletePlugin
 * adds, not by the index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills the unique partial index in any environment missing it.
 */
const migration: MigrationFile = {
  id: 20260903000000,
  name: 'ensure scopedsetting settingname index',

  up: async () => {
    await ScopedSetting.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
