import { PushTokenModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build PushToken's indexes: the unique `token` constraint (one row per device or activity token, which
 * the registration upsert relies on to collapse concurrent registers) plus { userId, kind } and { sid }.
 * `autoIndex` is off in deployed environments, so the schema declarations alone never build them.
 *
 * Id sits below 20260922000001, which must stay the last core migration (see index.ts).
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921236960,
  name: 'ensure pushtoken indexes',

  up: async () => {
    await PushTokenModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
