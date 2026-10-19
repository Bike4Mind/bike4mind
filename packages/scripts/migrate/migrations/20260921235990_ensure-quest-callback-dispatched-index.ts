import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ 'callback.state': 1, 'callback.dispatchedAt': 1 }` index exists on quests.
 *
 * It serves findStaleDispatchedCallbacks, the questTimeoutSweep backstop that re-enqueues a
 * generation callback stuck at `dispatched` with no queue message behind it. Pre-built rather
 * than left to autoIndex for the same DocumentDB foreground-lock reason as
 * 20260921235900_ensure-quest-callback-pending-index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235990,
  name: 'ensure quest callback dispatched index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping this one would put the sweep backstop on a collection scan.
  },
};

export default migration;
