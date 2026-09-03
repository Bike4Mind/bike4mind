import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ status: 1, updatedAt: 1 }` exists on quests.
 *
 * `findStaleRunning` (the questTimeoutSweep cron) selects `status: 'running'` over an `updatedAt`
 * range every 5 minutes. No pre-existing index has a usable `status` prefix - `id_status` is
 * `{_id: 1, status: 1}` - so without this the sweep collection-scans the largest collection in
 * the database on every run. Declared on the schema too, but relying on autoIndex alone would
 * build it lazily on a cold boot of whichever Lambda touches quests first after deploy, possibly
 * a user's poll: same rationale as 20260728000000_ensure-fabfilechunk-keyset-index and
 * 20260820000000_ensure-lakeaccessevent-questid-index.
 *
 * Migration rather than autoIndex is load-bearing here, not just tidy. This index is dense - both
 * fields exist on every quest - and prod runs DocumentDB, where an index build runs in the
 * foreground holding a collection lock (see 20260529000000_datalake-org-scoped-slug-index). On a
 * collection this size that stall belongs in a migration window, not on a request path.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260826000000,
  name: 'ensure quest status updatedAt index',

  up: async () => {
    await Quest.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the timeout sweep back on a
    // collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
