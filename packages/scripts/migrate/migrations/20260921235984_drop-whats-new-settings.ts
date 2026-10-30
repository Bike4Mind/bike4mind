import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * The What's New generation pipeline was deleted, and its settings (`whatsNewConfig`,
 * `whatsNewSyncConfig`, `whatsNewAutomationEnabled`) were dropped from `SettingKeySchema` /
 * `settingsMap`. Two more names were written by the deleted code without ever being registry
 * keys: `whatsNewConfigHistory` (the config history trail, potentially a large JSON blob) and
 * `whatsNewGenerationStatus` (per-run status). Dropping the keys hides the rows from every read
 * that goes through `settingsMap`, but the documents linger on any deployment that configured or
 * ran the pipeline, and nothing can delete them any more. Delete them.
 *
 * Hard delete for the same reason as 20260921235982: AdminSettings carries softDeletePlugin,
 * whose tombstone would leave the unique `settingName` key permanently unsettable.
 *
 * Idempotent: a second run deletes nothing.
 */

/** Exported so a test can pin these against `settingsMap`: deleting a name that is a LIVE
 *  setting key again would destroy a real admin row, so the two must never overlap. */
export const DEAD_SETTING_NAMES = [
  'whatsNewAutomationEnabled',
  'whatsNewConfig',
  'whatsNewConfigHistory',
  'whatsNewSyncConfig',
  'whatsNewGenerationStatus',
];

const migration: MigrationFile = {
  // Backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which is kept
  // last so its fail-closed throw blocks only itself.
  id: 20260921235984,
  name: 'drop-whats-new-settings',

  up: async () => {
    // `hardDelete` is absent from mongoose's DeleteOptions, hence the cast.
    const removed = await AdminSettings.deleteMany({ settingName: { $in: DEAD_SETTING_NAMES } }, {
      hardDelete: true,
    } as Record<string, unknown>);
    console.log(
      `[drop-whats-new-settings] hard-deleted ${removed.deletedCount ?? 0} orphaned row(s): ${DEAD_SETTING_NAMES.join(', ')}`
    );
  },

  // Irreversible by design: the keys no longer exist in the schema, and the pipeline that read
  // these values is gone, so restoring them would restore nothing meaningful.
  down: async () => {},
};

export default migration;
