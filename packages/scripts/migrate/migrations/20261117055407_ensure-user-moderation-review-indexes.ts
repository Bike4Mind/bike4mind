import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261117055407,
  name: 'ensure-user-moderation-review-indexes',

  // Builds the moderation review indexes declared on UserModel. createIndexes is idempotent.
  up: async () => {
    await User.createIndexes();
  },

  // The indexes are additive; nothing to undo.
  down: async () => {},
};

export default migration;
