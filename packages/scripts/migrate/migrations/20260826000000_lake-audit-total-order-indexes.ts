import { LakeAccessEventModel, LakeConfigChangeEventModel, safeDropIndex } from '@bike4mind/database';
import type * as mongoose from 'mongoose';
import { type MigrationFile } from './index';

/**
 * Extend the three lake-audit read indexes with a trailing `_id: -1`, then drop the shorter
 * indexes they supersede.
 *
 * `listByLake`/`listByPrincipal` on both audit collections now sort `{ createdAt: -1, _id: -1 }`
 * so the order is total: two events written in the same millisecond always come back in the same
 * relative order, and a `limit` window is reproducible. That sort is only index-served if `_id` is
 * in the index key too - with the old `{ ..., createdAt: -1 }` indexes the planner would add a
 * blocking in-memory SORT on collections whose retention runs years.
 *
 * autoIndex creates the extended indexes under new names but never removes the old ones, and each
 * old key is an exact prefix of its replacement, so they are pure insert-time cost on every
 * environment deployed before this change. Dropped here, by key pattern rather than by name: an
 * auto-derived name is not guaranteed identical on every engine (prod runs DocumentDB), and
 * dropping by a hardcoded name would let a mismatch make `safeDropIndex` swallow the drop as
 * "not found" while the migration still records as applied - permanently un-retryable.
 *
 * Refuses to drop unless the replacement is present and actually usable for the read (not hidden,
 * partial, or non-default collation); otherwise the collection would lose its only index for that
 * query and fall back to a full scan. A collection that does not exist yet is nothing to do -
 * autoIndex builds the extended index on first write.
 */
const SUPERSEDED: Array<{ collection: mongoose.Collection; replacement: object; legacy: object }> = [
  {
    collection: LakeConfigChangeEventModel.collection,
    replacement: { dataLakeId: 1, createdAt: -1, _id: -1 },
    legacy: { dataLakeId: 1, createdAt: -1 },
  },
  {
    collection: LakeAccessEventModel.collection,
    replacement: { resolvedLakeIds: 1, createdAt: -1, _id: -1 },
    legacy: { resolvedLakeIds: 1, createdAt: -1 },
  },
  {
    collection: LakeAccessEventModel.collection,
    replacement: { principalKind: 1, principalId: 1, createdAt: -1, _id: -1 },
    legacy: { principalKind: 1, principalId: 1, createdAt: -1 },
  },
];

const migration: MigrationFile = {
  id: 20260826000000,
  name: 'lake audit total order indexes',

  up: async () => {
    await LakeConfigChangeEventModel.createIndexes();
    await LakeAccessEventModel.createIndexes();

    for (const { collection, replacement, legacy } of SUPERSEDED) {
      const db = collection.conn.db;
      if (!db) {
        throw new Error('No active MongoDB connection - cannot check lake audit collection state');
      }
      const exists = (await db.listCollections({ name: collection.collectionName }).toArray()).length === 1;
      if (!exists) {
        console.log(`${collection.collectionName} not present (skipping index drops)`);
        continue;
      }

      const indexes = await collection.indexes();
      const replacementIndex = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(replacement));
      if (
        !replacementIndex ||
        replacementIndex.hidden ||
        replacementIndex.partialFilterExpression ||
        replacementIndex.collation
      ) {
        throw new Error(
          `Refusing to drop ${JSON.stringify(legacy)} on ${collection.collectionName}: a usable ` +
            `${JSON.stringify(replacement)} is missing (absent, hidden, partial, or non-default collation). ` +
            'Dropping it would leave that audit read with no index to serve it.'
        );
      }

      const match = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(legacy));
      if (match?.name) {
        await safeDropIndex(collection, match.name);
      }
    }
  },

  down: async () => {
    // The dropped keys are prefixes of indexes that remain, so nothing is lost to restore.
    // Narrowing the sort back to `createdAt` alone would reintroduce the unstable order.
  },
};

export default migration;
