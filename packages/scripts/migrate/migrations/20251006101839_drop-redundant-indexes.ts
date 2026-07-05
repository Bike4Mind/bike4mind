import { FabFile, QuestMasterArtifact, safeDropIndex, UserApiKey } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251006101839,
  name: 'drop redundant indexes',

  up: async () => {
    await safeDropIndex(UserApiKey.collection, 'userId_1');
    await safeDropIndex(FabFile.collection, 'deletedAt_1_sessionId_1');
    await safeDropIndex(FabFile.collection, 'deletedAt_1_userId_1');
    await safeDropIndex(QuestMasterArtifact.collection, 'projectId_1');
    await safeDropIndex(QuestMasterArtifact.collection, 'sessionId_1');
    await safeDropIndex(QuestMasterArtifact.collection, 'tags_1');
    await safeDropIndex(QuestMasterArtifact.collection, 'userId_1');
  },

  down: async () => {},
};

export default migration;
