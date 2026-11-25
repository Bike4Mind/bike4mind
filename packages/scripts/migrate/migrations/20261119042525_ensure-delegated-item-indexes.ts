import { DelegatedItemModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the delegated item indexes exist: `{ userId: 1, briefedAt: 1, createdAt: 1 }` serves the brief's
 * unbriefed read and `{ userId: 1, status: 1, createdAt: 1 }` its stale-pending sweep. The collection is new
 * and empty, so the build is instant; the migration exists because autoIndex is off outside tests.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261119042525,
  name: 'ensure delegated item indexes',

  up: async () => {
    await DelegatedItemModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; nothing to undo.
  },
};

export default migration;
