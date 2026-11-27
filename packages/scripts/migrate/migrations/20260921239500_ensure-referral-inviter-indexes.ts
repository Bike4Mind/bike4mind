import { ReferralSubscriptionRewardModel, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the indexes the inviter's referral counts read: `user_referredByUserId` on users and the inviterId
 * index on subscription rewards (apps/client/server/referrals/inviterSummary.ts). Idempotent: createIndexes
 * is a no-op for indexes that already exist, and the names match the schema declarations.
 */
const migration: MigrationFile = {
  id: 20260921239500,
  name: 'ensure referral inviter indexes',

  up: async () => {
    await User.createIndexes();
    await ReferralSubscriptionRewardModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
