import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `user_deletionRequestedAt` index exists on users. It serves the daily account
 * deletion sweep's scan for accounts past their grace period (apps/workers/src/cron/accountDeletionSweep.ts).
 * Idempotent: createIndexes is a no-op for indexes that already exist, and the name matches the schema
 * declaration.
 */
const migration: MigrationFile = {
  id: 20260921237400,
  name: 'ensure user deletion requested index',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
