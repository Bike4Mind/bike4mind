import { CallableFunction } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the lookups behind the list of functions shared with a person: by named person, by organization and state,
 * and by project. `autoIndex` is off in the deployed environments, so the schema declarations never build there.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20261124025013,
  name: 'ensure callable function grant indexes',

  up: async () => {
    await CallableFunction.createIndexes();
  },

  down: async () => {
    // One-way. The lookups only speed up reads.
  },
};

export default migration;
