import { AuthEventModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the AuthEvent indexes exist, the 90-day TTL above all: it is what bounds how long raw
 * signup/login IPs are kept, so it has to exist before the first write rather than whenever a cold
 * boot's fire-and-forget autoIndex gets to it (see 20260902000000_ensure-quest-retrieval-index).
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235972,
  name: 'ensure authevent indexes',

  up: async () => {
    await AuthEventModel.createIndexes();
  },

  down: async () => {
    // Dropping the TTL index would keep raw IPs forever. Removal, if ever wanted, is a deliberate
    // forward migration.
  },
};

export default migration;
