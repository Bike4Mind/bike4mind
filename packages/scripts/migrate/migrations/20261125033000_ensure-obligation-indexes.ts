import { ObligationModel, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

const UNIQUE_FILE_INDEX = 'userId_1_fileId_1';

// IndexOptionsConflict and IndexKeySpecsConflict: an index of the same name or key exists with other options.
const INDEX_CONFLICT_CODES: ReadonlySet<unknown> = new Set([85, 86]);

// Matched on the code alone: an instanceof check breaks when a bundle carries two copies of the driver.
function isIndexConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && INDEX_CONFLICT_CODES.has(error.code);
}

async function hasPartialUniqueFileIndex(): Promise<boolean> {
  const indexes = await ObligationModel.collection.indexes();
  return indexes.some(index => index.name === UNIQUE_FILE_INDEX && index.partialFilterExpression !== undefined);
}

/**
 * Ensure the obligation indexes exist: the unique `{ userId, fileId }` that makes a hand-off idempotent,
 * `{ userId, status, dueDate }` for the brief's due-soon read and `{ userId, _id: -1 }` for the list. The
 * migration exists because autoIndex is off outside tests.
 *
 * A database that ran a pre-release build of the model holds the unique index with a partial filter on
 * `fileId`, and MongoDB refuses to build an index whose name matches one with other options. That copy
 * is dropped and rebuilt; any other conflict is rethrown untouched. `fileId` is a required string, so the
 * filter excluded no stored row and the rebuild meets no duplicate among them. MongoDB cannot change an
 * index's options in place, so uniqueness is unenforced between the drop and the rebuild.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261125033000,
  name: 'ensure obligation indexes',

  up: async () => {
    try {
      await ObligationModel.createIndexes();
    } catch (error) {
      if (!isIndexConflict(error) || !(await hasPartialUniqueFileIndex())) throw error;
      await safeDropIndex(ObligationModel.collection, UNIQUE_FILE_INDEX);
      await ObligationModel.createIndexes();
    }
  },

  down: async () => {
    // Indexes are additive; nothing to undo.
  },
};

export default migration;
