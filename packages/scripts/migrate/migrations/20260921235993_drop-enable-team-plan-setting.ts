import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * `enableTeamPlan` was removed from `SettingKeySchema`: the Subscriptions modal shows the Team tab
 * whenever a Team Stripe price is live, so the toggle no longer gated anything. Dropping the key
 * already hides the row from every read; delete the lingering `adminsettings` document too.
 *
 * Same hard-delete idiom (and reason) as 20260911000000_drop-dead-feature-default-settings.
 * Idempotent: a second run deletes nothing.
 */

/** Exported so a test can pin these against `settingsMap`; see the 20260911000000 migration. */
export const DEAD_SETTING_NAMES = ['enableTeamPlan'];

const migration: MigrationFile = {
  id: 20260921235993,
  name: 'drop-enable-team-plan-setting',

  up: async () => {
    // Without hardDelete, softDeletePlugin tombstones the row; see 20260911000000.
    const removed = await AdminSettings.deleteMany({ settingName: { $in: DEAD_SETTING_NAMES } }, {
      hardDelete: true,
    } as Record<string, unknown>);
    console.log(
      `[drop-enable-team-plan-setting] hard-deleted ${removed.deletedCount ?? 0} orphaned row(s): ${DEAD_SETTING_NAMES.join(', ')}`
    );
  },

  down: async () => {},
};

export default migration;
