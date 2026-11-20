import { PaymentRiskActionModel, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the indexes behind the automatic payment-risk responses: the unique key on
 * PaymentRiskAction (what makes a redelivered fraud warning act once) and the partial
 * `user_signupMeta_ip` index the linked-account lookup reads.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. Backdated below the
 * fail-closed OAuth backfill, which must stay the highest id on disk.
 */
const migration: MigrationFile = {
  id: 20260921236700,
  name: 'ensure payment risk link indexes',

  up: async () => {
    await PaymentRiskActionModel.createIndexes();
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
