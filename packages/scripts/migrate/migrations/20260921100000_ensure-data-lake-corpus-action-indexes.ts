import { DataLakeCorpusActionModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the DataLakeCorpusAction collection's indexes (#3046).
 *
 * Neither index is unique - this is an append-only audit trail, and two curators acting on one
 * finding is two events rather than a conflict. They are here for the reads: a lake's history and
 * one finding's, both sorted newest-first, on a collection that only ever grows.
 *
 * Migration rather than autoIndex, for the reasons the sibling ensure-*-index migrations give:
 * `mongo.ts` sets autoIndex but only awaits `connect`, so a build is fire-and-forget and a failure
 * is silent; and prod runs DocumentDB, where a build takes a foreground collection lock - taken by
 * whichever Lambda cold-boots onto the collection first, i.e. a user's request rather than a
 * migration window.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921100000,
  name: 'ensure data lake corpus action indexes',

  up: async () => {
    await DataLakeCorpusActionModel.createIndexes();
  },

  down: async () => {
    // Both indexes are read-path only, so dropping them costs latency rather than correctness -
    // but nothing here needs reversing, and a removal would be a deliberate forward migration.
  },
};

export default migration;
