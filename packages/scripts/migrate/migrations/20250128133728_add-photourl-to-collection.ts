import { MigrationFile } from '.';
import { User } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20250128133728,
  name: 'Add photoUrl to collection',

  up: async () => {
    await User.updateMany({ photoUrl: { $exists: false } }, { $set: { photoUrl: null } });
  },

  down: async () => {
    await User.updateMany({}, { $unset: { photoUrl: '' } });
  },
};

export default migration;
