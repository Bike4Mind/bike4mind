import { Artifact, CounterLog, FabFile, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251002113208,
  name: 'drop redundant indexes',

  up: async () => {
    await safeDropIndex(CounterLog.collection, 'datetime_1');
    await safeDropIndex(CounterLog.collection, 'userId_1');
    await safeDropIndex(Artifact.collection, 'organizationId_1');
    await safeDropIndex(Artifact.collection, 'projectId_1');
    await safeDropIndex(Artifact.collection, 'sessionId_1');
    await safeDropIndex(Artifact.collection, 'tags_1');
    await safeDropIndex(Artifact.collection, 'type_1');
    await safeDropIndex(Artifact.collection, 'userId_1');
    await safeDropIndex(FabFile.collection, 'deletedAt_1_userId_1');
  },

  down: async () => {},
};

export default migration;
