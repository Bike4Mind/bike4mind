import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const INDEX_NAME = 'user_releasedPlatformEmailAddresses_address';

const migration: MigrationFile = {
  id: 20261126141312,
  name: 'add released platform email index',

  up: async () => {
    await User.collection.createIndex(
      { 'releasedPlatformEmailAddresses.address': 1 },
      { sparse: true, name: INDEX_NAME }
    );
  },

  down: async () => {
    await User.collection.dropIndex(INDEX_NAME).catch(() => undefined);
  },
};

export default migration;
