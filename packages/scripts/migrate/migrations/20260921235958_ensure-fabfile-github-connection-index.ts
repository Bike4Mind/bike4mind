import { FabFile, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the FabFile GitHub reconcile index before the first GitHub ingest reads through it; autoIndex builds are
 * fire-and-forget on cold boot. Id sits below 20260922000001, which must stay the highest (see its test).
 */
const migration: MigrationFile = {
  id: 20260921235958,
  name: 'ensure fabfile github connection index',

  up: async () => {
    await FabFile.collection.createIndex({ githubConnectionId: 1, deletedAt: 1, status: 1 });
  },

  down: async () => {
    await safeDropIndex(FabFile.collection, 'githubConnectionId_1_deletedAt_1_status_1');
  },
};

export default migration;
