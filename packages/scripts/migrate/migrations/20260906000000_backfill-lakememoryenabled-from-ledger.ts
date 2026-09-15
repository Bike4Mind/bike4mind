import { DataLakeModel, memoryLedgerRepository } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[backfill-lakememoryenabled-from-ledger]';

/**
 * Backfill `lakeMemoryEnabled: true` for every lake that ALREADY has a surviving lake-memory
 * profile, so a lake built before the per-lake gate existed does not silently go dark the
 * moment this ships - `recallLakeMemoryForSession` gates recall on `lake.lakeMemoryEnabled !== true`,
 * and a lake with beliefs already in the ledger but no value on this new field would otherwise stop
 * serving them with no action from its owner.
 *
 * Ledger-derived, NEVER keyed on `lakeMemoryExtractionAt`: that field is a concurrency LEASE, not a
 * completion stamp, and its steady state on a successfully-built lake is `null` - selecting on it
 * here would miss every lake this migration exists to find. `shredded: { $ne: true }` excludes a lake
 * whose profile was purged (Phase 4 crypto-shred): a shred is an in-place update, not a delete, so an
 * unfiltered distinct would re-enable a lake whose owner deliberately erased its profile.
 *
 * Unconditional and no-op-safe: runs the same way regardless of the `EnableLakeMemory` platform flag
 * or any per-lake state, and only writes the lakes it finds - an environment with no lake-memory
 * ledger rows yet does nothing.
 */
const migration: MigrationFile = {
  id: 20260906000000,
  name: 'backfill-lakememoryenabled-from-ledger',

  up: async () => {
    const tags = await memoryLedgerRepository.distinctSurvivingPrincipalIds('lake');
    if (tags.length === 0) {
      console.log(`${LOG} no surviving lake ledger chains found, nothing to do`);
      return;
    }
    const result = await DataLakeModel.updateMany(
      { datalakeTag: { $in: tags }, lakeMemoryEnabled: { $ne: true } },
      { $set: { lakeMemoryEnabled: true } }
    );
    console.log(`${LOG} ${tags.length} lake(s) with a surviving profile; ${result.modifiedCount} enabled`);
  },

  // Reverses exactly the population `up` would find AT THE TIME `down` runs, not necessarily the
  // exact set `up` actually touched - a lake independently enabled through the build door's own
  // toggle in between is indistinguishable from one this migration enabled. Best-effort undo, not
  // a guaranteed exact inverse; the field is fully re-derivable by re-running `up`.
  down: async () => {
    const tags = await memoryLedgerRepository.distinctSurvivingPrincipalIds('lake');
    if (tags.length === 0) return;
    const result = await DataLakeModel.updateMany(
      { datalakeTag: { $in: tags } },
      { $set: { lakeMemoryEnabled: false } }
    );
    console.log(`${LOG} down: disabled lakeMemoryEnabled for ${result.modifiedCount} lake(s)`);
  },
};

export default migration;
