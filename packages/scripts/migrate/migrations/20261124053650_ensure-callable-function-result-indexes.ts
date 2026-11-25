import { CallableFunctionResult } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the asynchronous call results' indexes: the unique call id, the per-caller lookup, and the 24-hour expiry on
 * `createdAt`. `autoIndex` is off in the deployed environments, so without this no result would expire.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20261124053650,
  name: 'ensure callable function result indexes',

  up: async () => {
    await CallableFunctionResult.createIndexes();
  },

  down: async () => {
    // One-way. Dropping the expiry would keep results, outputs included, past 24 hours.
  },
};

export default migration;
