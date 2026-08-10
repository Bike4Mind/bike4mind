import { FabFileChunk, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

const KEYSET_COMPOUND_KEY = { fabFileId: 1, _id: 1 };
const LEGACY_KEYS = [{ _id: 1, fabFileId: 1 }, { fabFileId: 1 }];

/**
 * Drop the two obsolete fabfilechunks indexes that predate the `{ fabFileId: 1, _id: 1 }` keyset
 * compound: `{ _id: 1, fabFileId: 1 }` (usually named `_id_1_fabFileId_1`) and `{ fabFileId: 1 }`
 * (usually named `fabFileId_1`). Neither declaration exists on the schema anymore, so autoIndex
 * will not recreate them, but they still exist in every environment deployed before the
 * declarations were removed.
 *
 * Both the precondition and the two drops below match by key pattern rather than by name, since an
 * auto-derived name is not guaranteed identical on every engine (prod runs DocumentDB). Dropping by
 * a hardcoded name would let a name mismatch make `safeDropIndex` silently swallow the drop as
 * "not found" while this migration still gets recorded as applied - permanently un-retryable.
 *
 * Refuses to drop if the keyset compound is missing, or present but not actually usable to serve a
 * bare `fabFileId` equality read (hidden, narrowed by a partial filter, or built with a non-default
 * collation): doing so would leave the collection unable to serve that read from an index, turning
 * it into a full collection scan.
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
    const keysetCompound = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(KEYSET_COMPOUND_KEY));
    if (
      !keysetCompound ||
      keysetCompound.hidden ||
      keysetCompound.partialFilterExpression ||
      keysetCompound.collation
    ) {
      throw new Error(
        'Refusing to drop the legacy fabfilechunks indexes: a usable { fabFileId: 1, _id: 1 } ' +
          'keyset compound is missing (absent, hidden, partial, or non-default collation). Run migration 20260728000000 ' +
          '(ensure fabfilechunk keyset index) first and confirm it applied - dropping the legacy ' +
          'indexes without it would leave the collection unable to serve a fabFileId read from an ' +
          'index, turning every such query into a full collection scan.'
      );
    }

    for (const key of LEGACY_KEYS) {
      const match = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
      if (match?.name) {
        await safeDropIndex(FabFileChunk.collection, match.name);
      }
    }
  },

  down: async () => {
    // Recreating undeclared legacy indexes is never wanted, so this drop is intentionally one-way.
  },
};

export default migration;
