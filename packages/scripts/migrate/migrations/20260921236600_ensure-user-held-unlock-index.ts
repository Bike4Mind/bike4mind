import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `user_signupGrant_heldUnlock_releaseAt` index exists on users. It serves the
 * hourly held-release job's scan for payment unlocks that have settled
 * (apps/workers/src/cron/signupGrantHeldRelease.ts). Idempotent: createIndexes is a no-op for
 * indexes that already exist, and the name matches the schema declaration.
 */
const migration: MigrationFile = {
  id: 20260921236600,
  name: 'ensure user held unlock index',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
