import { Artifact } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ userId, deletedAt, _id }` index exists on artifacts.
 *
 * GET /api/v1/artifacts pages a user's own live artifacts by `_id` (artifactRepository.listOwnedAfterId).
 * Without this index the planner walks one of the (userId, ...) indexes and sorts every artifact the
 * user has in memory for each page.
 *
 * Migration rather than autoIndex, for the same reason as 20260921235999_ensure-fabfile-owned-keyset-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock, and left to autoIndex
 * it would build on whichever Lambda's cold boot touches artifacts first after deploy.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235994,
  name: 'ensure artifact owned keyset index',

  up: async () => {
    await Artifact.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the public artifact list back on an
    // in-memory sort. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
