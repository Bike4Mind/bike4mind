import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * The admin subscriptions list sorts: createdAt and periodEndsAt with an _id tiebreak, plus status ahead
 * of createdAt for the status views. Must match the schema.index lines in
 * apps/client/server/models/Subscription.ts, which this package cannot import, hence the raw driver.
 *
 * Migration rather than autoIndex, for the same reason as 20260902000000_ensure-quest-retrieval-index:
 * autoIndex builds are fire-and-forget, so a failure is silent.
 *
 * Id sits below 20260922000001, which must stay the last core migration (see index.ts).
 *
 * Idempotent: createIndex is a no-op for an index that already exists with the same key.
 */
export const SUBSCRIPTION_ADMIN_LIST_INDEXES: Record<string, 1 | -1>[] = [
  { createdAt: -1, _id: -1 },
  { periodEndsAt: 1, _id: 1 },
  { status: 1, createdAt: -1, _id: -1 },
];

const migration: MigrationFile = {
  id: 20260921236200,
  name: 'ensure subscription admin list indexes',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');
    const subscriptions = db.collection('subscriptions');
    for (const key of SUBSCRIPTION_ADMIN_LIST_INDEXES) {
      await subscriptions.createIndex(key);
    }
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
