import { ObligationModel, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

const UNIQUE_FILE_INDEX = 'userId_1_fileId_1';
const MAX_REPORTED_DUPLICATE_GROUPS = 5;

type StoredIndex = Awaited<ReturnType<typeof ObligationModel.collection.indexes>>[number];

/** True for a stored copy that is not the plain unique index the model declares. */
function differsFromDeclared(index: StoredIndex): boolean {
  return (
    index.unique !== true ||
    index.partialFilterExpression !== undefined ||
    index.sparse === true ||
    index.collation !== undefined
  );
}

/** Fails before any index is touched when stored rows would break the unique `{ userId, fileId }` build. */
async function assertNoDuplicateFiles(): Promise<void> {
  const duplicates = await ObligationModel.aggregate<{ ids: unknown[] }>([
    // A missing fileId and a null one collide in a unique index, so they are grouped together.
    { $group: { _id: { userId: '$userId', fileId: { $ifNull: ['$fileId', null] } }, ids: { $push: '$_id' } } },
    { $match: { 'ids.1': { $exists: true } } },
    { $limit: MAX_REPORTED_DUPLICATE_GROUPS },
  ]);
  if (duplicates.length === 0) return;

  const detail = duplicates.map(group => `[${group.ids.map(String).join(', ')}]`).join('; ');
  throw new Error(
    `Cannot build the unique { userId, fileId } obligation index: rows share a user and file. ` +
      `Keep one row per group and rerun. Row ids by group: ${detail}`
  );
}

/**
 * Ensure the obligation indexes exist; autoIndex is off outside tests.
 *
 * A database that ran a pre-release build of the model holds the unique index with other options, which
 * MongoDB will not build over, so that copy is dropped first. Uniqueness is unenforced until the rebuild
 * lands: a duplicate written in that window fails the build, and the rerun reports its row ids.
 */
const migration: MigrationFile = {
  id: 20261125033000,
  name: 'ensure obligation indexes',

  up: async () => {
    await ObligationModel.createCollection();
    await assertNoDuplicateFiles();

    const indexes = await ObligationModel.collection.indexes();
    if (indexes.some(index => index.name === UNIQUE_FILE_INDEX && differsFromDeclared(index))) {
      await safeDropIndex(ObligationModel.collection, UNIQUE_FILE_INDEX);
    }

    await ObligationModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; nothing to undo.
  },
};

export default migration;
