import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the full `{ deletedAt, timestamp, _id }` ordering used by Model Logs pagination.
 * Without the tie-break in the index, a page fetch reads and sorts every matching quest.
 * Explicitly await the build instead of relying on a cold boot's asynchronous autoIndex.
 * The id precedes the deferred OAuth backfill so its operator gate cannot block this index.
 */
const migration: MigrationFile = {
  id: 20260921235938,
  name: 'ensure quest model logs pagination index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Additive index: removal, if needed, belongs in an explicit forward migration.
  },
};

export default migration;
