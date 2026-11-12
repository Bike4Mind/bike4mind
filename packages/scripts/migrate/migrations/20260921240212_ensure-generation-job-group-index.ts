import { GenerationJobModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the GenerationJob { requestedBy, payload.groupId } index behind findByGroup, which runs once per finished
 * Studio image take to decide whether its group is complete.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921240212,
  name: 'ensure generation job group index',

  up: async () => {
    await GenerationJobModel.createIndexes();
  },

  down: async () => {
    // Read-path index only; removal would be a deliberate forward migration.
  },
};

export default migration;
