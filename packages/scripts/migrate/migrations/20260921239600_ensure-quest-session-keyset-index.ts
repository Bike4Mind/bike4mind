import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build `{ sessionId: 1, timestamp: 1, _id: 1 }` (sessionId_timestamp_id) on quests.
 *
 * findPageAfterBySessionId pages a session's turns oldest first by (timestamp, _id). No earlier
 * index carries the _id tie-break, so each page sorted the session's remaining turns in memory
 * and walking a whole session cost O(N^2 / limit) documents examined. Explicitly awaited rather
 * than left to a cold boot's asynchronous autoIndex. The id sits below the fail-closed OAuth
 * backfill so its operator gate cannot block this index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already match.
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
