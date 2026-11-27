import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * The GitHub, work-email and organization-invite unlock settings were removed from
 * `SettingKeySchema` / `settingsMap`. Dropping the keys hides the rows from every read, but they
 * linger in `adminsettings` on any deployment where an admin configured them, with no way to
 * clear them from the admin UI. Delete the rows.
 *
 * Hard delete for the same reason as 20260911000000: AdminSettings carries softDeletePlugin, whose
 * tombstone would leave the unique `settingName` key permanently unsettable.
 *
 * Idempotent: a second run deletes nothing.
 */

/** Exported so a test can pin these against `settingsMap`: deleting a name that is a LIVE
 *  setting key again would destroy a real admin row, so the two must never overlap. */
export const DEAD_SETTING_NAMES = [
  'noCardUnlockEnabled',
  'noCardUnlockGithubCredits',
  'noCardUnlockWorkEmailCredits',
  'noCardUnlockMaxCredits',
  'noCardUnlockGithubMinAgeDays',
  'noCardUnlockGithubMinRepos',
  'noCardUnlockWorkEmailDomainDailyCap',
  'noCardUnlockProbeInconclusiveAllows',
  'signupGrantOrgInviteEnabled',
];

const migration: MigrationFile = {
  id: 20260921239700,
  name: 'drop-retired-unlock-settings',

  up: async () => {
    // `hardDelete` is absent from mongoose's DeleteOptions, hence the cast.
    const removed = await AdminSettings.deleteMany({ settingName: { $in: DEAD_SETTING_NAMES } }, {
      hardDelete: true,
    } as Record<string, unknown>);
    console.log(
      `[drop-retired-unlock-settings] hard-deleted ${removed.deletedCount ?? 0} orphaned row(s): ${DEAD_SETTING_NAMES.join(', ')}`
    );
  },

  // Irreversible by design: the keys no longer exist in the schema.
  down: async () => {},
};

export default migration;
