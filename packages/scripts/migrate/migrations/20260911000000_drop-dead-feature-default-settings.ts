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
 * admin ever flipped either toggle. Delete them so nothing stale is left behind, matching the
 * `prReportSlackChannel` cleanup in 20260814000000.
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
    const removed = await AdminSettings.deleteMany({ settingName: { $in: DEAD_SETTING_NAMES } });
    console.log(
      `[drop-dead-feature-default-settings] removed ${removed.deletedCount ?? 0} orphaned row(s): ${DEAD_SETTING_NAMES.join(', ')}`
    );
  },

  // Irreversible by design: the keys no longer exist in the schema, so recreating the rows
  // would restore documents that every read path already ignores.
  down: async () => {},
};

export default migration;
