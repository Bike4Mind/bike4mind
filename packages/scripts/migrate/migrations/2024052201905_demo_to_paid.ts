import { type MigrationFile } from './index';
import { User } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 2024052201905,
  name: 'convert demo users to paid users',

  // Change users with level 'DemoUser' to 'PaidUser' (UserLevelType in UserTypes.ts).

  up: async () => {
    await User.updateMany({ level: 'DemoUser' }, { $set: { level: 'PaidUser' } });
  },

  down: async () => {
    await User.updateMany({ level: 'PaidUser' }, { $set: { level: 'DemoUser' } });
  },
};

export default migration;
