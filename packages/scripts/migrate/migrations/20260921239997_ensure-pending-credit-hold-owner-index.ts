import { PendingCreditHoldModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build PendingCreditHold's { ownerId, ownerType, settledAt } index, which serves the admin billing
 * overview's sum of an owner's outstanding holds (PendingCreditHoldModel.ts).
 * `autoIndex` is off in deployed environments, so the schema declaration alone never builds it.
 *
 * Id sits below 20260922000001, which must stay the last core migration (see index.ts).
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921239997,
  name: 'ensure pending credit hold owner index',

  up: async () => {
    await PendingCreditHoldModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
