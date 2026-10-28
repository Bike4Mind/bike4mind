import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `user_riskScore_review` index exists on users.
 *
 * The admin signup risk review queue (apps/client/pages/api/admin/signup-risk-reviews.ts) lists
 * users with a pending review, highest score first. Without this index that read scans users.
 *
 * Migration rather than autoIndex for the reason given in 20260918010000_ensure-user-organizationid-index:
 * prod runs DocumentDB, where an index build on users takes a foreground collection lock. Key, name and
 * options must match the UserModel.ts declaration byte-for-byte, or this build and autoIndex hit an
 * IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260921235956,
  name: 'ensure user riskScore review index',

  up: async () => {
    await User.collection.createIndex(
      { 'riskScore.reviewState': 1, 'riskScore.score': -1 },
      { name: 'user_riskScore_review' }
    );
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the review queue back on a collection
    // scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
