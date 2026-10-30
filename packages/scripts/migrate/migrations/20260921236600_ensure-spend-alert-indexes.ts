import { SpendAlert } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the SpendAlert unique sparse openKey index (one open incident per rule and scope), the status
 * list index and the scope history index.
 *
 * Id sits below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay the highest id on disk.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921236600,
  name: 'ensure spend alert indexes',

  up: async () => {
    await SpendAlert.createIndexes();
  },

  down: async () => {
    // Index removal would be a deliberate forward migration.
  },
};

export default migration;
