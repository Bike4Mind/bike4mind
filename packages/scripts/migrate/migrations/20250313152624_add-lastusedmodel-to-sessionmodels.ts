import { Session as SessionModel } from '@bike4mind/database/auth';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250313152624,
  name: 'Add lastUsedModel to sessionmodels',

  up: async () => {
    await SessionModel.updateMany({ lastUsedModel: { $exists: false } }, { $set: { lastUsedModel: null } });
  },

  down: async () => {
    await SessionModel.updateMany({}, { $unset: { lastUsedModel: '' } });
  },
};

export default migration;
