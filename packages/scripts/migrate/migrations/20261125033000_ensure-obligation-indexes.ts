import { ObligationModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the obligation indexes exist: the unique `{ userId, fileId }` that makes a hand-off idempotent,
 * `{ userId, status, dueDate }` for the brief's due-soon read and `{ userId, _id: -1 }` for the list. The
 * collection is new and empty, so the build is instant; the migration exists because autoIndex is off outside tests.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261125033000,
  name: 'ensure obligation indexes',

  up: async () => {
    await ObligationModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; nothing to undo.
  },
};

export default migration;
