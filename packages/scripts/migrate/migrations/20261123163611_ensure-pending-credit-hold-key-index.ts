import { PendingCreditHoldModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build PendingCreditHold's partial unique { holdKey } index, which keeps one outstanding hold per
 * image generation when its queue message is redelivered (PendingCreditHoldModel.ts).
 * `autoIndex` is off in deployed environments, so the schema declaration alone never builds it.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261123163611,
  name: 'ensure pending credit hold key index',

  up: async () => {
    await PendingCreditHoldModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
