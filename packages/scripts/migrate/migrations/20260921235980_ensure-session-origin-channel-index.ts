import { Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ deletedAt, userId, 'origin.channel', lastUpdated }` index exists on sessions.
 *
 * GET /api/sessions (and /shared) filter on origin/excludeOrigin via an `$in` over
 * 'origin.channel' alongside the existing deletedAt/userId/lastUpdated predicates; without this
 * index those queries fall back to the pre-existing (deletedAt, userId, lastUpdated) index and
 * filter origin in memory.
 *
 * Migration rather than autoIndex, for the same reason as 20260902000000_ensure-quest-retrieval-index
 * and 20260826000000_ensure-quest-status-updatedat-index: prod runs DocumentDB, where an index build
 * takes a foreground collection lock. Left to autoIndex, this one would build on whichever Lambda's
 * cold boot touches sessions first after deploy - a live request, not a migration window.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235980,
  name: 'ensure session origin.channel index',

  up: async () => {
    await Session.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the origin/excludeOrigin filters back
    // on a collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
