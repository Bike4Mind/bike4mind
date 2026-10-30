import { User } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260921235939,
  name: 'ensure signup fingerprint window index',
  up: async () => {
    await User.collection.createIndex(
      { createdAt: 1, 'signupMeta.ja4': 1 },
      { name: 'user_signup_fingerprint_window' }
    );
  },
  down: async () => {
    await User.collection.dropIndex('user_signup_fingerprint_window');
  },
};

export default migration;
