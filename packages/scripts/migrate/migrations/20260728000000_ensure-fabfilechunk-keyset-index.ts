import { FabFileChunk } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ fabFileId: 1, _id: 1 }` exists on fabfilechunks.
 *
 * Semantic retrieval pages chunk vectors with a keyset cursor (`fabFileId $in` + sort on `_id`);
 * without this index the planner has to collect and sort each page instead of merging the
 * per-file scans, so paging a large lake degrades from a streamed walk to a blocking sort.
 * Declared on the schema too, but relying on autoIndex alone would build it lazily on a cold
 * boot of whichever Lambda touches the collection first - on a collection this size that belongs
 * in a migration, not on a request path.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds EVERY index the
 * schema declares, which today is only this one - a future schema addition would be built here too.
 * Plain compound index, so nothing here depends on DocumentDB-specific index support. `down` is
 * intentionally one-way.
 */
const migration: MigrationFile = {
  id: 20260728000000,
  name: 'ensure fabfilechunk keyset index',

  up: async () => {
    await FabFileChunk.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping this one would regress retrieval paging.
    // Removal, if ever wanted, should be a deliberate forward migration.
  },
};

export default migration;
