import { EmailTriageItemModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261118164439,
  name: 'ensure email triage section pending index',

  up: async () => {
    await EmailTriageItemModel.collection.createIndex({ userId: 1, briefedAt: 1, kind: 1, createdAt: 1 });
  },

  down: async () => {
    // Additive: retain both pending-read indexes and the existing unique emailId index.
  },
};

export default migration;
