import mongoose from 'mongoose';
import type { MigrationFile } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20260921240062,
  name: 'ensure dlq history paging indexes',
  up: async () => {
    const collection = mongoose.connection.collection('dlqreplaylogs');
    await collection.createIndex({ createdAt: -1, _id: -1 });
    await collection.createIndex({ queueLabel: 1, createdAt: -1, _id: -1 });
  },
  down: async () => {},
};

export default migration;
