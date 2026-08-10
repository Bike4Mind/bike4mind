import { FabFileChunk, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Drop the two obsolete fabfilechunks indexes that predate the `{ fabFileId: 1, _id: 1 }` keyset
 * compound: `{ _id: 1, fabFileId: 1 }` (name `_id_1_fabFileId_1`) and `{ fabFileId: 1 }` (name
 * `fabFileId_1`). Neither declaration exists on the schema anymore, so autoIndex will not recreate
 * them, but they still exist in every environment deployed before the declarations were removed.
 *
 * The precondition below matches by key pattern rather than the compound's auto-derived name,
 * since that name is not guaranteed to be generated identically on every engine (prod runs
 * DocumentDB) and a mismatch there must not silently skip the safety check.
 *
 * Refuses to drop if the keyset compound is missing: doing so before it exists would leave the
 * collection with only `_id_`, turning every bare `fabFileId` read into a full collection scan.
 * `safeDropIndex` only swallows index-not-found, so a genuinely absent collection (a fresh
 * environment that never created it) is checked for up front and treated as nothing to do, rather
 * than reaching a NamespaceNotFound throw from the drop calls themselves.
 */
const migration: MigrationFile = {
  id: 20260810000000,
  name: 'drop legacy fabfilechunk indexes',

  up: async () => {
    const db = FabFileChunk.db.db;
    if (!db) {
      throw new Error('No active MongoDB connection - cannot check fabfilechunks collection state');
    }

    const collectionExists =
      (await db.listCollections({ name: FabFileChunk.collection.collectionName }).toArray()).length === 1;
    if (!collectionExists) {
      console.log('fabfilechunks collection not present (skipping index drops)');
      return;
    }

    const indexes = await FabFileChunk.collection.indexes();
    const hasKeysetCompound = indexes.some(
      index => JSON.stringify(index.key) === JSON.stringify({ fabFileId: 1, _id: 1 })
    );
    if (!hasKeysetCompound) {
      throw new Error(
        'Refusing to drop the legacy fabfilechunks indexes: the { fabFileId: 1, _id: 1 } keyset ' +
          'compound is missing. Run migration 20260728000000 (ensure fabfilechunk keyset index) ' +
          'first and confirm it applied - dropping _id_1_fabFileId_1 and fabFileId_1 without it ' +
          'would leave only _id_, turning every fabFileId query into a full collection scan.'
      );
    }

    await safeDropIndex(FabFileChunk.collection, '_id_1_fabFileId_1');
    await safeDropIndex(FabFileChunk.collection, 'fabFileId_1');
  },

  down: async () => {},
};

export default migration;
