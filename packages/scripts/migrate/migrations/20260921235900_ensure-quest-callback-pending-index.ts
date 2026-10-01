import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ 'callback.state': 1, updatedAt: 1 }` index exists on quests.
 *
 * It serves findUndispatchedCallbacks, the questTimeoutSweep backstop that re-dispatches a
 * generation callback whose settle-site claim was missed. The partial filter keeps the index
 * tiny, but a partial filter narrows what the index stores, not what the build scans: the build
 * still reads every quest, and on DocumentDB it holds a foreground collection lock. Same
 * rationale as 20260826000000_ensure-quest-status-updatedat-index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235900,
  name: 'ensure quest callback pending index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping this one would put the sweep backstop on a collection scan.
  },
};

export default migration;
