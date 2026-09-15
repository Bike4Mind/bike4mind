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
    // safeDropIndex only swallows index-not-found errors, so guard on the
    // collection existing first - fresh environments never create it.
    const questMasterArtifactsExists =
      (await FabFile.db.db?.listCollections({ name: 'questmaster_artifacts' }).toArray())?.length === 1;
    if (questMasterArtifactsExists) {
      const questMasterArtifacts = FabFile.db.collection('questmaster_artifacts');
      await safeDropIndex(questMasterArtifacts, 'projectId_1');
      await safeDropIndex(questMasterArtifacts, 'sessionId_1');
      await safeDropIndex(questMasterArtifacts, 'tags_1');
      await safeDropIndex(questMasterArtifacts, 'userId_1');
    } else {
      console.log('questmaster_artifacts collection not present (skipping index drops)');
    }
  },

  down: async () => {},
};

export default migration;
