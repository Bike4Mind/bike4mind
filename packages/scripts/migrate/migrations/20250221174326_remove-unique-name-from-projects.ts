import { type MigrationFile } from './index';
import mongoose from 'mongoose';

const migration: MigrationFile = {
  id: 20250221174326,
  name: 'remove-unique-name-from-projects',

  up: async () => {
    const collection = mongoose.connection.collection('projects');

    const hasIndex = await collection.indexExists('name');

    if (hasIndex) {
      await collection.dropIndex('name');
    }

    await collection.createIndex({ name: 1, userId: 1 }, { unique: false });
  },

  down: async () => {},
};

export default migration;
