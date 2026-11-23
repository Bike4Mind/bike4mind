import { CallableFunction } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the two unique indexes saved callable functions rely on for integrity:
 * - `callablefn_owner_slug`: one name per owner, so a tool id built from the name is unambiguous.
 * - `callablefn_owner_artifact`: one function per artifact per owner.
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
    // One-way. Dropping the unique indexes would let duplicate names and duplicate artifacts build up.
  },
};

export default migration;
