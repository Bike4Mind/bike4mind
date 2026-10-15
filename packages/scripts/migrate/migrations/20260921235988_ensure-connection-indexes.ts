import { Connection } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the Connection indexes the realtime revoke paths and the realtimeConnectionSweep cron
 * query by: userId, sid and apiKeyId (all plain indexes). `autoIndex` is off in
 * the deployed environments, so the schema declarations alone never build them there.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260921235988,
  name: 'ensure connection realtime lifecycle indexes',

  up: async () => {
    await Connection.createIndexes();
  },

  down: async () => {
    // One-way. The indexes are cheap and the revoke and sweep queries rely on them.
  },
};

export default migration;
