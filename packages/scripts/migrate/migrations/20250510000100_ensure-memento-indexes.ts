import { Memento } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250510000100,
  name: 'ensure memento indexes',

  up: async () => {
    console.log('Ensuring indexes on Memento collection...');
    await Memento.createIndexes();
  },

  down: async () => {
    // Intentionally a no-op: dropping indexes could harm performance.
    // If required, uncomment the line below.
    // await Memento.collection.dropIndexes();
  },
};

export default migration;
