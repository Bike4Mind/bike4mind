import { safeDropIndex, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260921235973,
  name: 'ensure index on users.createdAt',

  up: async () => {
    // Serves the signup risk sweep, which pages through accounts created in the last 14 days.
    // Built here rather than left to autoIndex's lazy build. The name must match the schema
    // declaration (UserModel.ts) so the two never create the same key pattern under two names.
    await User.collection.createIndex({ createdAt: 1 }, { name: 'user_createdAt' });
    console.log('✓ Created user_createdAt index');
  },

  down: async () => {
    await safeDropIndex(User.collection, 'user_createdAt');
    console.log('✓ Dropped user_createdAt index');
  },
};

export default migration;
