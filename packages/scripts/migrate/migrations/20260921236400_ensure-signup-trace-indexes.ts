import { SignupTraceModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the SignupTrace indexes exist before the first account deletion writes one: the TTL is what
 * bounds how long the hashed network traces are kept, and the unique index is what makes a re-run
 * purge idempotent (see 20260921235972_ensure-authevent-indexes).
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921236400,
  name: 'ensure signup trace indexes',

  up: async () => {
    await SignupTraceModel.createIndexes();
  },

  down: async () => {
    // Dropping the TTL index would keep the traces forever. Removal, if ever wanted, is a
    // deliberate forward migration.
  },
};

export default migration;
