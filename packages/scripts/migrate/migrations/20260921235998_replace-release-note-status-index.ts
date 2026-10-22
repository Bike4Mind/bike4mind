import { ReleaseNote } from '@bike4mind/database';
import { type MigrationFile } from './index';

const OLD_INDEX_KEY = { status: 1, publishAt: -1 };

/**
 * Swap release_notes' { status, publishAt } index for the named { status, publishAt, _id } one the
 * keyset-paged reader and admin lists sort on. Neither autoIndex nor createIndexes drops an index the
 * schema stopped declaring, so the old one is dropped explicitly.
 *
 * The old index is found by key pattern, not by its auto-derived name, which can differ on DocumentDB.
 * Idempotent: a missing collection or old index is skipped and createIndexes is a no-op for existing indexes.
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay last.
 */
const migration: MigrationFile = {
  id: 20260921235998,
  name: 'replace release note status index',

  up: async () => {
    const db = ReleaseNote.db.db;
    if (!db) throw new Error('No active MongoDB connection - cannot check release_notes collection state');

    const collectionExists =
      (await db.listCollections({ name: ReleaseNote.collection.collectionName }).toArray()).length === 1;
    if (collectionExists) {
      const oldIndex = (await ReleaseNote.collection.indexes()).find(
        index => JSON.stringify(index.key) === JSON.stringify(OLD_INDEX_KEY)
      );
      if (oldIndex?.name) await ReleaseNote.collection.dropIndex(oldIndex.name);
    }
    await ReleaseNote.createIndexes();
  },

  down: async () => {
    // The new index is a superset of the old one's prefix, so leaving it in place is safe.
  },
};

export default migration;
