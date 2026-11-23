import { SpendFreeze } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the SpendFreeze partial unique index (one active freeze per scope), the lifted/frozen list index
 * and the scope history index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261116135232,
  name: 'ensure spend freeze indexes',

  up: async () => {
    await SpendFreeze.createIndexes();
  },

  down: async () => {
    // Index removal would be a deliberate forward migration.
  },
};

export default migration;
