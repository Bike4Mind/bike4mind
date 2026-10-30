import { RevenueSnapshotModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the unique `snapshotDate` index exists on revenuesnapshots.
 *
 * The daily revenueSnapshot cron upserts on `snapshotDate`, and only this index keeps two
 * concurrent runs for the same day (EventBridge delivers at least once) from inserting two rows.
 * Left to autoIndex, the build is fire-and-forget: a duplicate written first makes it fail
 * silently, and the constraint never exists. Id backdated below
 * BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), like its index-migration siblings.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921237000,
  name: 'ensure revenue snapshot date index',

  up: async () => {
    await RevenueSnapshotModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would let a cron rerun duplicate a day.
  },
};

export default migration;
