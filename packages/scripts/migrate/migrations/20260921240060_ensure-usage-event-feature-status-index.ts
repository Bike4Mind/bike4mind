import { UsageEvent } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ feature, status, createdAt }` index on usageevents exists. The hourly completion
 * sequence and synchrony sweeps read the last 24 hours of successful `completion_api` rows
 * (completionSequenceEvents.ts, completionCohortExposure.ts); without it, every run scans the
 * whole UsageEvent collection.
 *
 * Migration rather than autoIndex: autoIndex builds are fire-and-forget (a failure is silent) and
 * run on whichever Lambda cold-boots first. See 20260902000000_ensure-quest-retrieval-index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and also backfills any of
 * the model's other declared indexes an environment happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260921240060,
  name: 'ensure usage event feature status index',

  up: async () => {
    await UsageEvent.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the hourly sweeps back on collection
    // scans. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
