import mongoose from 'mongoose';
import { AdminSettings } from '@bike4mind/database';
import type { MigrationFile } from './index';
import { PIN_MARKER_COLLECTION } from './20260921237480_pin-signup-grant-schedule-keys';

/** Exported so a test can pin these against `settingsMap`: deleting a live key would destroy a real admin row. */
export const DEAD_SIGNUP_GRANT_SETTING_NAMES = [
  'signupGrantActivityMinMessages',
  'signupGrantActivityMinDays',
  'defaultSeats',
  'verifiedUnlockCredits',
  'signupGrantActivityMaxCredits',
  'signupGrantActivityEnabled',
  'signupGrantActivityDailyCredits',
  'stagedSignupGrantEnabled',
  'defaultFreeCredits',
  'signupGrantCredits',
  'signupGrantDailyBudget',
];

export const BACKUP_COLLECTION = PIN_MARKER_COLLECTION;

interface RowBackup {
  kind: 'row';
  settingName: string;
  row: Record<string, unknown>;
}

/**
 * Backs up, then hard-deletes, the `adminsettings` rows of the signup grant keys removed from
 * `settingsMap`. Must sort after 20260921237500_seed-signup-grant-pools, which still reads
 * signupGrantDailyBudget. The raw collection is used so softDeletePlugin tombstones go too: a
 * tombstone would keep the unique `settingName` unsettable.
 */
const migration: MigrationFile = {
  id: 20260921239996,
  name: 'drop-retired-grant-settings',

  up: async () => {
    const rows = await AdminSettings.collection
      .find({ settingName: { $in: DEAD_SIGNUP_GRANT_SETTING_NAMES } })
      .toArray();
    const backups = mongoose.connection.collection<RowBackup>(BACKUP_COLLECTION);
    for (const row of rows) {
      const settingName = String(row.settingName);
      await backups.updateOne(
        { kind: 'row', settingName },
        { $set: { kind: 'row', settingName, row } },
        { upsert: true }
      );
    }
    const removed = await AdminSettings.collection.deleteMany({
      settingName: { $in: DEAD_SIGNUP_GRANT_SETTING_NAMES },
    });
    console.log(`[drop-retired-grant-settings] backed up and deleted ${removed.deletedCount} row(s)`);
  },

  // Restores each backed-up row unless an operator has since recreated that setting; keeps the backup.
  down: async () => {
    const backups = await mongoose.connection.collection<RowBackup>(BACKUP_COLLECTION).find({ kind: 'row' }).toArray();
    for (const { settingName, row } of backups) {
      await AdminSettings.collection.updateOne({ settingName }, { $setOnInsert: row }, { upsert: true });
    }
  },
};

export default migration;
