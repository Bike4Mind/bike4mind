import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ userId, deletedAt, archivedAt, _id }` index exists on fabfiles.
 *
 * GET /api/v1/files pages a user's own live, unarchived files by `_id` (fabFileRepository.listOwnedBeforeId).
 * Without this index the planner walks one of the (deletedAt, userId, ...) indexes and sorts every
 * file the user has in memory for each page.
 *
 * Migration rather than autoIndex, for the same reason as 20260907000000_ensure-fabfile-tagname-filename-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock, and left to autoIndex
 * it would build on whichever Lambda's cold boot touches fabfiles first after deploy.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235999,
  name: 'ensure fabfile owned keyset index',

  up: async () => {
    await FabFile.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the public file list back on an
    // in-memory sort. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
