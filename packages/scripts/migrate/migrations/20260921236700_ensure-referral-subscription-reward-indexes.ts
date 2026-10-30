import { ReferralSubscriptionRewardModel } from '@bike4mind/database';
import type { MigrationFile } from './index';

// The unique invoiceId and stepKey indexes are what stop a reward being recorded twice, so they are built
// here rather than left to autoIndex, which fails silently.
const migration: MigrationFile = {
  id: 20260921236700,
  name: 'ensure referral subscription reward indexes',
  up: async () => {
    await ReferralSubscriptionRewardModel.createIndexes();
  },
  down: async () => {},
};
export default migration;
