import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the multikey `images` index exists on quests.
 *
 * userCanAccessGeneratedImage resolves a generated-file key back to its owning session by matching
 * `{ images: <key> }` on the quests collection (see QuestRepository.findSessionIdsByImage). That
 * authz lookup runs on every serve and copy of a generated image, so the key -> session resolution
 * must be index-backed rather than a scan of the largest collection in the database.
 *
 * Migration rather than autoIndex, for the same reason as
 * 20260902000000_ensure-quest-retrieval-index / 20260826000000_ensure-quest-status-updatedat-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock. Left to autoIndex,
 * this one would build on whichever Lambda's cold boot first touches quests after deploy - a user's
 * serve/copy request, not a migration window.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and builds every index the
 * schema declares (so it also backfills any other declared index an environment is missing). The
 * index name (`images`) matches the schema declaration byte-for-byte, so this build and autoIndex
 * cannot produce an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260909000000,
  name: 'ensure quest images index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the generated-image authz lookup back
    // on a collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
