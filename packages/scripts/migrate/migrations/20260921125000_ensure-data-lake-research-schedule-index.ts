import { DataLakeResearchConfigModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `nextRunAt` index on data lake research configs, which the research scheduler's
 * due-config scan (`claimDueConfigs`) reads every tick.
 *
 * Migration rather than autoIndex for the same reason as 20260902000000_ensure-quest-retrieval-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock on whichever cold
 * boot touches the collection first.
 *
 * The id sorts below 20260921130000 and 20260922000001 on purpose: both are fail-closed backfills
 * that throw until an operator confirms, and a throw aborts every migration sorted after it.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921125000,
  name: 'ensure data lake research schedule index',

  up: async () => {
    await DataLakeResearchConfigModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
