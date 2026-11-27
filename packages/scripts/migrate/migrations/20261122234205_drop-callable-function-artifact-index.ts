import { CallableFunction, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Drops `callablefn_owner_artifact`, which allowed one tool per artifact, so that a version a repin refuses can be
 * saved as a new tool beside the old one. Names stay unique per owner through `callablefn_owner_slug`.
 */
const migration: MigrationFile = {
  id: 20261122234205,
  name: 'drop callable function artifact index',

  up: async () => {
    await safeDropIndex(CallableFunction.collection, 'callablefn_owner_artifact');
  },

  down: async () => {
    // One-way. Rebuilding it fails once an artifact holds two tools.
  },
};

export default migration;
