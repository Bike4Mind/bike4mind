import { CallableFunctionReview } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the unique (function, person) index behind recipients' reviews and the lookup by person. `autoIndex` is off
 * in the deployed environments, so the schema declarations never build there.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20261124050904,
  name: 'ensure callable function review indexes',

  up: async () => {
    await CallableFunctionReview.createIndexes();
  },

  down: async () => {
    // One-way. The collection holds reviews that the unique index keeps to one per function and person.
  },
};

export default migration;
