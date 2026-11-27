import { CallableFunction } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the unique index saved callable functions rely on for integrity: `callablefn_owner_slug`, one name per
 * owner, so a tool id built from the name is unambiguous.
 *
 * `autoIndex` is off in the deployed environments, so the schema declarations never build there.
 * Must run before the setting that enables callable functions is turned on; once duplicates exist
 * this becomes data cleanup.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20261122143827,
  name: 'ensure callable function indexes',

  up: async () => {
    await CallableFunction.createIndexes();
  },

  down: async () => {
    // One-way. Dropping the unique index would let duplicate names build up.
  },
};

export default migration;
