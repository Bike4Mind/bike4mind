import { safeDropIndex, Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251126202452,
  name: 'fix session slackMetadata index',

  up: async () => {
    await safeDropIndex(Session.collection, 'userId_1_slackMetadata.channelId_1_slackMetadata.threadTs_1');
  },

  down: async () => {},
};

export default migration;
