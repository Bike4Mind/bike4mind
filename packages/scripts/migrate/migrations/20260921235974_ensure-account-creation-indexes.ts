import { User, UserApiKey } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260921235974,
  name: 'ensure account creation indexes',
  up: async () => {
    await User.collection.createIndex({ createdAt: 1 });
    await UserApiKey.collection.createIndex({ createdAt: 1 });
  },
  down: async () => {},
};

export default migration;
