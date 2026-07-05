import { SlackDevWorkspace, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Drop unique constraint from slackTeamId index
 *
 * Removes the unique constraint to allow multiple workspaces with null
 * slackTeamId (uninstalled apps). The non-unique replacement is created
 * automatically at app start, as defined in SlackDevWorkspaceModel.
 */
const migration: MigrationFile = {
  id: 20251210000000,
  name: 'drop slackTeamId unique index',

  up: async () => {
    await safeDropIndex(SlackDevWorkspace.collection, 'slackTeamId_1');
  },

  down: async () => {
    // Cannot safely recreate the unique index if multiple null values exist
    // Manual intervention would be required to restore uniqueness
  },
};

export default migration;
