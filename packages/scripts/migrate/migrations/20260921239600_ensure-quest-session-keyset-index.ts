import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build `{ sessionId: 1, timestamp: 1, _id: 1 }` (sessionId_timestamp_id) on quests.
 *
 * findPageAfterBySessionId pages a session's turns oldest first by (timestamp, _id). No earlier
 * index carries the _id tie-break, so each page sorted the session's remaining turns in memory
 * and walking a whole session cost O(N^2 / limit) documents examined.
 *
 * Migration rather than autoIndex, for the same reason as 20260921235966_ensure-quest-signup-activity-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock, and autoIndex
 * would run it on whichever Lambda's cold boot first touches quests after deploy.
 *
 * Idempotent: createIndexes is a no-op for indexes that already match. The id sits below the
 * fail-closed OAuth backfill so its operator gate cannot block this index.
 */
const migration: MigrationFile = {
  id: 20260921239600,
  name: 'ensure quest session keyset index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Additive index: removal, if needed, belongs in an explicit forward migration.
  },
};

export default migration;
