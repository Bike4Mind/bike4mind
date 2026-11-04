import { StripeDisputeModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the StripeDispute indexes exist before the webhook first writes the collection.
 *
 * The unique `stripeDisputeId` index is load-bearing: the webhook upserts by it, so without it two
 * concurrent deliveries of one dispute could insert two records. autoIndex builds are fire-and-forget
 * (a failure is silent), so this does not wait for a cold boot. Idempotent: createIndexes is a no-op
 * for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921238300,
  name: 'ensure stripe dispute indexes',

  up: async () => {
    await StripeDisputeModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping the unique one would let duplicate dispute records in.
  },
};

export default migration;
