import { Memento } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251024141313,
  name: 'permanently delete existing mementos',

  up: async () => {
    // Delete all mementos that don't have an embedding
    await Memento.deleteMany({ embedding: { $exists: false } });
  },

  down: async () => {
    // No down migration
  },
};

export default migration;
