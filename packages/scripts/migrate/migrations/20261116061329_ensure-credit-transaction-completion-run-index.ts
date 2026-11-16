import { CreditTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the CreditTransaction run index (credit_tx_completion_run) exists, so a completion run's
 * usage read does not scan the ledger.
 *
 * Migration rather than autoIndex, as 20260902000000_ensure-quest-retrieval-index explains:
 * autoIndex builds are fire-and-forget and a failure is silent.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261116061329,
  name: 'ensure credit transaction completion run index',

  up: async () => {
    await CreditTransaction.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
