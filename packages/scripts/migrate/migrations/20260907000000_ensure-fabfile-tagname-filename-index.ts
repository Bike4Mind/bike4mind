import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ 'tags.name': 1, fileName: 1, deletedAt: 1 }` exists on fabfiles.
 *
 * `findLakeMemberSiblingsByFileName` runs this lookup PER ADMITTED FILE at the post-chunk admission
 * checkpoint (#2238). `fileName` otherwise appears only inside a compound TEXT index, which cannot
 * serve an equality predicate, so without this index the best plan is the `{ 'tags.name',
 * archivedAt, deletedAt }` tag range plus an in-memory name filter - fine at a few hundred members
 * and not fine on a widely-shared tag.
 *
 * Declared on the schema too, but a request-path index on a collection this size belongs in a
 * migration rather than being left to autoIndex: prod runs DocumentDB, where the build takes a
 * foreground lock, and autoIndex would take it lazily on a cold boot of whichever Lambda touches
 * the collection first. Same rationale as 20260814000001_ensure-fabfile-userid-tagname-index and
 * 20260902000000_ensure-quest-retrieval-index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of FabFile's other declared indexes an environment
 * happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260907000000,
  name: 'ensure fabfile tagname filename index',

  up: async () => {
    await FabFile.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
