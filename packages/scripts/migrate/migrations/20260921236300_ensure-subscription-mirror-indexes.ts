import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the admin subscriptions list indexes on subscriptions: { source, status, periodEndsAt }
 * (renewing soon, per source) and { cancelAtPeriodEnd, status } (the Canceling view, over the
 * Stripe mirror fields). Must stay in sync with the declarations in
 * apps/client/server/models/Subscription.ts. See docs/admin-subscriptions-spec.md section 6.1.
 *
 * Raw createIndex rather than Model.createIndexes(): the Subscription model lives in apps/client,
 * which this package cannot import. Migration rather than autoIndex, because autoIndex is off in
 * deployed stages.
 *
 * Id sits below 20260922000001, which must stay the last core migration (see index.ts).
 *
 * Idempotent: createIndex is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260921236300,
  name: 'ensure subscription mirror indexes',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const subscriptions = db.collection('subscriptions');
    await subscriptions.createIndex({ source: 1, status: 1, periodEndsAt: 1 });
    await subscriptions.createIndex({ cancelAtPeriodEnd: 1, status: 1 });
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
