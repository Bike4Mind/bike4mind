import { FabFile, safeDropIndex, UserApiKey } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251006101839,
  name: 'drop redundant indexes',

  up: async () => {
    await safeDropIndex(UserApiKey.collection, 'userId_1');
    await safeDropIndex(FabFile.collection, 'deletedAt_1_sessionId_1');
    await safeDropIndex(FabFile.collection, 'deletedAt_1_userId_1');
    // Raw collection handle: the QuestMasterArtifact model was removed.
    // safeDropIndex is a no-op when the collection or index does not exist.
    const questMasterArtifacts = FabFile.db.collection('questmaster_artifacts');
    await safeDropIndex(questMasterArtifacts, 'projectId_1');
    await safeDropIndex(questMasterArtifacts, 'sessionId_1');
    await safeDropIndex(questMasterArtifacts, 'tags_1');
    await safeDropIndex(questMasterArtifacts, 'userId_1');
  },

  down: async () => {},
};

export default migration;
