import { LakeAccessEventModel, LakeConfigChangeEventModel, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Rebuild the two lake-audit listByLake indexes with an `_id: -1` suffix, and drop the superseded
 * two-key versions they replace.
 *
 * The `listByLake` read on both collections sorts `{ createdAt: -1, _id: -1 }` so a paged reader
 * (assembleLakeConfigHistory, assembleLakeAccessView) reports the same window boundary on every
 * load of the same page. An index that stops at `createdAt` cannot supply that order: the planner
 * drops the indexed sort and puts a blocking SORT above FETCH, so every read pulls the lake's whole
 * retention window (450 days of access events, 1095 of config changes) instead of `limit` rows -
 * worst on the 2000-row compliance-export path.
 *
 * Superseded keys are dropped by key pattern rather than by auto-derived name, since prod runs
 * DocumentDB and a name mismatch would let safeDropIndex swallow the drop as "not found" while
 * this migration is still recorded as applied. Each drop is guarded on its replacement actually
 * existing, so a failed build can never leave the collection without an index for that read.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and a drop whose target is
 * already gone matches nothing. Both models' full declared index sets are built, so this also
 * backfills any other declared index an environment happens to be missing.
 */
type IndexKey = Record<string, number>;

const SUPERSEDED: Array<{
  collection: typeof LakeAccessEventModel.collection;
  legacy: IndexKey;
  replacement: IndexKey;
}> = [
  {
    collection: LakeConfigChangeEventModel.collection,
    legacy: { dataLakeId: 1, createdAt: -1 },
    replacement: { dataLakeId: 1, createdAt: -1, _id: -1 },
  },
  {
    collection: LakeAccessEventModel.collection,
    legacy: { resolvedLakeIds: 1, createdAt: -1 },
    replacement: { resolvedLakeIds: 1, createdAt: -1, _id: -1 },
  },
];

const migration: MigrationFile = {
  id: 20260827000000,
  name: 'ensure lake audit tiebreak indexes',

  up: async () => {
    await LakeConfigChangeEventModel.createIndexes();
    await LakeAccessEventModel.createIndexes();

    for (const { collection, legacy, replacement } of SUPERSEDED) {
      const indexes = await collection.indexes();
      const hasReplacement = indexes.some(index => JSON.stringify(index.key) === JSON.stringify(replacement));
      if (!hasReplacement) {
        throw new Error(
          `Refusing to drop ${collection.collectionName} index ${JSON.stringify(legacy)}: its ` +
            `${JSON.stringify(replacement)} replacement is missing, so the drop would leave the ` +
            'read without an index-supported sort.'
        );
      }
      const match = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(legacy));
      if (match?.name) {
        await safeDropIndex(collection, match.name);
      }
    }
  },

  down: async () => {
    // Indexes are additive; recreating the superseded two-key versions is never wanted.
  },
};

export default migration;
