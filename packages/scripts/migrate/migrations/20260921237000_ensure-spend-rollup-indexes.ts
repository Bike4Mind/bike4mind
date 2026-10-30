import { SpendRollup } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the SpendRollup unique bucket key, the scope lookup index and the 35-day TTL.
 *
 * Id sits below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay the highest id on disk.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921237000,
  name: 'ensure spend rollup indexes',

  up: async () => {
    await SpendRollup.createIndexes();
  },

  down: async () => {
    // Index removal would be a deliberate forward migration.
  },
};

export default migration;
