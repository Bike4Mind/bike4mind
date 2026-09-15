import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * `EnableDataLakesDefault` and `EnableOptiHashiDefault` were removed from `SettingKeySchema`:
 * both were admin-visible toggles that seeded nothing, because neither feature has a per-user
 * preference for an `Enable<Feature>Default` row to seed.
 *
 * Dropping the keys already hides the rows from every read - a `settingName` with no
 * `settingsMap` entry is skipped by the settings projection and treated as sensitive by the
 * broadcast redaction - but the documents linger in `adminsettings` on any deployment where an
 * admin ever flipped either toggle. Delete them so nothing stale is left behind.
 *
 * Hard delete, for the reason spelled out on the call below. Note that 20260814000000, the
 * `prReportSlackChannel` cleanup this was first modelled on, omits that option and so tombstones
 * its row rather than removing it; the idiom to copy is 20251008130737 instead.
 *
 * Idempotent: a second run deletes nothing.
 */

/** Exported so a test can pin these against `settingsMap` - deleting a name that is a LIVE
 *  setting key again would destroy a real admin row, so the two must never overlap. */
export const DEAD_SETTING_NAMES = ['EnableDataLakesDefault', 'EnableOptiHashiDefault'];

const migration: MigrationFile = {
  id: 20260911000000,
  name: 'drop-dead-feature-default-settings',

  up: async () => {
    // AdminSettings carries softDeletePlugin, which replaces `deleteMany` with an updateMany
    // that stamps `deletedAt` unless `hardDelete` is passed - and then reports modifiedCount as
    // `deletedCount`, so a soft delete reads like a real one. A tombstone is worse than the live
    // row here: `settingName` is a plain unique index with no partialFilterExpression, and the
    // admin upsert does not clear `deletedAt`, so the key would become permanently unsettable.
    // The option is absent from mongoose's DeleteOptions, hence the cast.
    const removed = await AdminSettings.deleteMany({ settingName: { $in: DEAD_SETTING_NAMES } }, {
      hardDelete: true,
    } as Record<string, unknown>);
    console.log(
      `[drop-dead-feature-default-settings] hard-deleted ${removed.deletedCount ?? 0} orphaned row(s): ${DEAD_SETTING_NAMES.join(', ')}`
    );
  },

  // Irreversible by design: the keys no longer exist in the schema, so recreating the rows
  // would restore documents that every read path already ignores.
  down: async () => {},
};

export default migration;
