import { CallableFunctionCall } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the call log's indexes: the per-function and per-caller lookups and the 90-day expiry on `startedAt`.
 * `autoIndex` is off in the deployed environments, so without this the log would never expire.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20261124002810,
  name: 'ensure callable function call indexes',

  up: async () => {
    await CallableFunctionCall.createIndexes();
  },

  down: async () => {
    // One-way. Dropping the expiry would keep call rows past 90 days.
  },
};

export default migration;
