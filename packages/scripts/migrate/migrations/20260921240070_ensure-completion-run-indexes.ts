import { CompletionRunModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the CompletionRun owner indexes exist, so data-subject export and erasure (which match
 * runs by userId and by ownerType + ownerId) do not scan the collection.
 *
 * Migration rather than autoIndex, as 20260902000000_ensure-quest-retrieval-index explains:
 * autoIndex builds are fire-and-forget and a failure is silent.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921240070,
  name: 'ensure completion run indexes',

  up: async () => {
    await CompletionRunModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
