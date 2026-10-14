import { Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ deletedAt, userId, _id }` index exists on sessions.
 *
 * GET /api/v1/sessions pages a user's own sessions by `_id` descending (sessionRepository.listByUserId).
 * Without this index the planner either walks the (deletedAt, userId, lastUpdated) index and sorts
 * every session the user has in memory for each page, or walks `_id` across all users' sessions.
 *
 * Migration rather than autoIndex, for the same reason as 20260921235980_ensure-session-origin-channel-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock, and left to autoIndex
 * it would build on whichever Lambda's cold boot touches sessions first after deploy.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235997,
  name: 'ensure session userId _id index',

  up: async () => {
    await Session.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the public session list back on an
    // in-memory sort. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
