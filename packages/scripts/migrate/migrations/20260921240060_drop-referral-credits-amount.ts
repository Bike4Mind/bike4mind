import mongoose from 'mongoose';
import { AdminSettings } from '@bike4mind/database';
import type { MigrationFile } from './index';
import { BACKUP_COLLECTION } from './20260921239996_drop-retired-grant-settings';

/** Exported so a test can pin it against `settingsMap`: deleting a live key would destroy a real admin row. */
export const RETIRED_SETTING_NAME = 'ReferralCreditsAmount';

interface RowBackup {
  kind: 'row';
  settingName: string;
  row: Record<string, unknown>;
}

/**
 * Backs up, then hard-deletes, the `adminsettings` row of the retired referral invitee grant
 * setting. Shares the backup collection and row shape of 20260921239996_drop-retired-grant-settings.
 * The raw collection is used so a softDeletePlugin tombstone goes too.
 */
const migration: MigrationFile = {
  id: 20260921240060,
  name: 'drop-referral-credits-amount',

  up: async () => {
    const rows = await AdminSettings.collection.find({ settingName: RETIRED_SETTING_NAME }).toArray();
    const backups = mongoose.connection.collection<RowBackup>(BACKUP_COLLECTION);
    for (const row of rows) {
      // Insert-only, so a rerun after an operator recreated the key keeps the original backup.
      await backups.updateOne(
        { kind: 'row', settingName: RETIRED_SETTING_NAME },
        { $setOnInsert: { kind: 'row', settingName: RETIRED_SETTING_NAME, row } },
        { upsert: true }
      );
    }
    const removed = await AdminSettings.collection.deleteMany({ settingName: RETIRED_SETTING_NAME });
    console.log(`[drop-referral-credits-amount] backed up and deleted ${removed.deletedCount} row(s)`);
  },

  // Restores the backed-up row unless an operator has since recreated the setting; keeps the backup.
  down: async () => {
    const backups = await mongoose.connection
      .collection<RowBackup>(BACKUP_COLLECTION)
      .find({ kind: 'row', settingName: RETIRED_SETTING_NAME })
      .toArray();
    for (const { row } of backups) {
      await AdminSettings.collection.updateOne(
        { settingName: RETIRED_SETTING_NAME },
        { $setOnInsert: row },
        { upsert: true }
      );
    }
  },
};

export default migration;
