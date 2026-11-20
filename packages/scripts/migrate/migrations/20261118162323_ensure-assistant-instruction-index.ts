import { AssistantInstructionModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ userId: 1, createdAt: 1 }` index exists on standing assistant instructions, which serves
 * the per-user list and count. The collection is new and empty, so the build is instant; the migration
 * exists because autoIndex is off outside tests.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261118162323,
  name: 'ensure assistant instruction index',

  up: async () => {
    await AssistantInstructionModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping this one would put instruction reads on a collection scan.
  },
};

export default migration;
