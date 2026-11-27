import { EmailTriageItemModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the email triage item indexes exist: the unique `emailId` index is what keeps one triage item per
 * email under concurrent analysis, and `{ userId: 1, briefedAt: 1, createdAt: 1 }` serves the brief's pending read. The
 * collection is new and empty, so the build is instant; the migration exists because autoIndex is off
 * outside tests.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261118072134,
  name: 'ensure email triage item indexes',

  up: async () => {
    await EmailTriageItemModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping the unique one would let a re-analyzed email triage twice.
  },
};

export default migration;
