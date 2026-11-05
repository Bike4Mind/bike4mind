import { BillingMismatchModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the indexes on billingmismatches exist.
 *
 * The nightly subscription reconciliation upserts findings by `stripeSubscriptionId`, and only the
 * unique index keeps two overlapping runs from inserting two rows for one subscription. Left to
 * autoIndex, the build is fire-and-forget and a duplicate written first makes it fail silently.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921239800,
  name: 'ensure billing mismatch indexes',

  up: async () => {
    await BillingMismatchModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping the unique one would let a rerun duplicate a finding.
  },
};

export default migration;
