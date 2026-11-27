import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `user_referralCode`, the unique index that resolves a share-link visit to its owner
 * (apps/client/server/referrals/shareLink.ts). Idempotent: createIndexes is a no-op for indexes that
 * already exist, and the name matches the schema declaration. Partial on string values, so the accounts
 * that never asked for a link carry no entry.
 */
const migration: MigrationFile = {
  id: 20261119212206,
  name: 'ensure referral code index',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
