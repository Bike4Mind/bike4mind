import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the dense `sessionId_correctsQuestId` index exists on quests.
 *
 * findCorrectionLinksBySessionId matches `{ sessionId, correctsQuestId: { $nin: [null, ''] },
 * deletedAt: null }` to walk a session's correction chain for the correction-pairs export; the
 * index serves that match so the walk does not scan the largest collection in the database.
 *
 * Migration rather than autoIndex, for the same reason as
 * 20260909000000_ensure-quest-images-index / 20260902000000_ensure-quest-retrieval-index: prod
 * runs DocumentDB, where an index build takes a foreground collection lock. Left to autoIndex,
 * this one would build on whichever Lambda's cold boot first touches quests after deploy - a
 * user's export request, not a migration window.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and builds every index the
 * schema declares (so it also backfills any other declared index an environment is missing). The
 * index name (`sessionId_correctsQuestId`) matches the schema declaration byte-for-byte, so this
 * build and autoIndex cannot produce an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260917000000,
  name: 'ensure quest corrects index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the correction-pairs export back on a
    // collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
