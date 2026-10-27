import { CreditTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `credit_tx_owner_balance_events` index exists on credit transactions.
 *
 * The admin user timeline (apps/client/server/utils/userTimeline.ts) lists a user's non-usage
 * credit events (purchases, renewals, grants, transfers) newest first. Usage rows outnumber them by
 * orders of magnitude, so without an index partial on exactly those types the query would walk every
 * usage row of a heavy user to find a page.
 *
 * Migration rather than autoIndex: autoIndex builds are fire-and-forget (a failure is silent).
 * Idempotent: createIndexes is a no-op for indexes that already exist, and it also backfills any of
 * this model's other declared indexes an environment happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260921235947,
  name: 'ensure credit transaction balance event index',

  up: async () => {
    await CreditTransaction.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
