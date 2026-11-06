import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `user_signupGrant_stage` index exists on users. It serves the Invite Center pending
 * list and summary (signupGrantPendingRepository in packages/database). Idempotent: createIndexes is a
 * no-op for indexes that already exist, and the name matches the schema declaration.
 */
const migration: MigrationFile = {
  id: 20260921999000,
  name: 'ensure user signup grant stage index',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
