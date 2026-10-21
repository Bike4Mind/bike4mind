import { LakeSkippedFileModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the LakeSkippedFile indexes exist: the unique (dataLakeId, sourceKind, sourceId) key that
 * keeps a re-skipped file one row, and the (dataLakeId, firstSeenAt) listing index. Migration rather
 * than autoIndex for the same reason as 20260921235962_ensure-github-lake-auth-grant-indexes:
 * autoIndex builds are fire-and-forget, so a failed unique build would go unreported.
 *
 * Id backdated below 20260922000001, which must stay the highest id on disk.
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235989,
  name: 'ensure lake skipped file indexes',

  up: async () => {
    await LakeSkippedFileModel.createIndexes();
  },

  down: async () => {
    // Additive; dropping the unique index would let a re-skip duplicate rows.
  },
};

export default migration;
