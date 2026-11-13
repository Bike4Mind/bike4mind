import { BillingEventModel, CreditTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the admin Payments report indexes exist: the partial purchases-by-date index on CreditTransaction,
 * and the by-type and payment follow-up indexes on BillingEvent. Left to autoIndex the builds are
 * fire-and-forget and can fail silently. Id backdated below BackfillOAuthClientTokenEndpointAuthMethod
 * (20260922000001), like its index-migration siblings.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921241035,
  name: 'ensure payments report indexes',

  up: async () => {
    await CreditTransaction.createIndexes();
    await BillingEventModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; nothing to undo.
  },
};

export default migration;
