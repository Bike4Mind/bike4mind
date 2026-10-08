import { AdminSettings, ScopedSetting } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[unset-stored-default-forced-retrieval-floor]';
const SETTING_NAME = 'forcedRetrievalMinSimilarityPct';

/** A stored 75 in any spelling (75, '75', ' 75', '75.0'). Exported for the sibling test. */
export const isStoredDefault = (value: unknown): boolean =>
  (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number(value) === 75;

/**
 * `forcedRetrievalMinSimilarityPct` used to read a stored 75 (its declared default) as "unset" and
 * resolve it per embedding space. It now honors a stored 75 in every space, so a row an admin left at
 * 75 - clearing the number field stored exactly that - would start pinning 0.75, which rejects every
 * chunk on text-embedding-3-small. Delete those rows, platform and org/owner overrides alike, so they
 * keep resolving per space. Lossless: no stored 75 ever pinned anything before this change.
 *
 * Hard delete: a soft-deleted platform tombstone would swallow later admin saves (see the hardDelete
 * note in apps/client/pages/api/settings/update.ts). Idempotent: a second run finds nothing.
 */
async function hardDeleteStoredDefaults(
  label: string,
  rows: Array<{ _id: unknown; settingValue?: unknown }>,
  deleteMany: (filter: Record<string, unknown>) => Promise<{ deletedCount?: number }>
): Promise<void> {
  const ids = rows.filter(r => isStoredDefault(r.settingValue)).map(r => r._id);
  if (ids.length === 0) return;
  const removed = await deleteMany({ _id: { $in: ids } });
  console.log(`${LOG} hard-deleted ${removed.deletedCount ?? 0} stored-75 row(s) from ${label}`);
}

const migration: MigrationFile = {
  id: 20260921235999,
  name: 'unset-stored-default-forced-retrieval-floor',

  up: async () => {
    const filter = { settingName: SETTING_NAME };
    // The option is absent from mongoose's DeleteOptions, hence the cast.
    const hard = { hardDelete: true } as Record<string, unknown>;
    await hardDeleteStoredDefaults('adminsettings', await AdminSettings.find(filter).lean(), f =>
      AdminSettings.deleteMany(f, hard)
    );
    await hardDeleteStoredDefaults('scopedsettings', await ScopedSetting.find(filter).lean(), f =>
      ScopedSetting.deleteMany(f, hard)
    );
  },

  // Irreversible by design: the deleted rows resolved per embedding space before and after.
  down: async () => {},
};

export default migration;
