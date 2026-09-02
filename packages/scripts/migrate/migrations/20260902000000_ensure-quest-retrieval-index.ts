import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `retrieval_timestamp_desc` index exists on quests.
 *
 * /api/admin/retrieval-rate matches `{ 'promptMeta.retrieval': { $exists: true } }` over a
 * `timestamp` range and sorts by `timestamp: -1`; the index is partial on exactly that predicate,
 * so the endpoint's sort and limit are served from the index instead of blocking-sorting the
 * largest collection in the database.
 *
 * Migration rather than autoIndex, for the same reason as
 * 20260826000000_ensure-quest-status-updatedat-index: prod runs DocumentDB, where an index build
 * takes a foreground collection lock. Left to autoIndex, this one would build on whichever
 * Lambda's cold boot touches quests first after deploy - a user's poll, not a migration window.
 * That sibling migration would build this index too (createIndexes builds every declared index),
 * but it has already been applied and selectPending filters on the applied-id set, so it will
 * never re-run to pick up an index declared afterwards.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260902000000,
  name: 'ensure quest retrieval timestamp index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the retrieval-rate endpoint back on a
    // collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
