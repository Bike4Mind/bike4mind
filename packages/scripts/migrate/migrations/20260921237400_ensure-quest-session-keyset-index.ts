import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ sessionId, timestamp, _id }` index exists on quests.
 *
 * GET /api/v1/sessions/{id}/quests pages a session's turns by (timestamp, _id) ascending
 * (questRepository.findPageAfterBySessionId). Without this index each page sorts every remaining
 * turn of the session in memory, or walks a global index and filters sessionId as a residual.
 *
 * Migration rather than autoIndex, for the same reason as 20260921235966_ensure-quest-signup-activity-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. Id backdated below
 * BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that migration's id the
 * highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921237400,
  name: 'ensure quest session keyset index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
