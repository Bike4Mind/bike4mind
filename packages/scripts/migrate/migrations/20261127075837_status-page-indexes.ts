import {
  StatusComponent,
  StatusComponentInterval,
  StatusDailyRollup,
  StatusBreakGlassQuarantine,
  StatusExternalTransition,
  StatusHistoryCorrection,
  StatusIncident,
  StatusOverride,
  StatusProbeResult,
  StatusProbeState,
  StatusSnapshot,
} from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Awaits the status page index builds, so the unique constraints exist before anything writes.
 * Idempotent: createIndexes skips an index that already exists.
 */
const migration: MigrationFile = {
  id: 20261127075837,
  name: 'status-page-indexes',

  up: async () => {
    await Promise.all(
      [
        StatusComponent,
        StatusProbeResult,
        StatusProbeState,
        StatusComponentInterval,
        StatusIncident,
        StatusOverride,
        StatusHistoryCorrection,
        StatusBreakGlassQuarantine,
        StatusExternalTransition,
        StatusDailyRollup,
        StatusSnapshot,
      ].map(model => model.createIndexes())
    );
  },

  down: async () => {
    // Indexes are additive; dropping the unique ones would let duplicate rows in.
  },
};

export default migration;
