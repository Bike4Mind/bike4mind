import { PaymentAttemptModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the PaymentAttempt indexes exist before the first payment writes one: the unique index on
 * paymentIntentId is what keeps a webhook redelivery from creating a second row, and the TTL bounds
 * how long the hashed network and card fingerprints are kept.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261030000000,
  name: 'ensure payment attempt indexes',

  up: async () => {
    await PaymentAttemptModel.createIndexes();
  },

  down: async () => {
    // Dropping the TTL index would keep the attempts forever. Removal, if ever wanted, is a
    // deliberate forward migration.
  },
};

export default migration;
