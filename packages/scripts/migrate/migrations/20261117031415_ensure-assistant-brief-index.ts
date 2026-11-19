import { AssistantBriefModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ userId: 1, createdAt: -1 }` index exists on assistant briefs, which serves the
 * per-user list and the latest-brief lookup. The collection is new and empty, so the build is
 * instant; the migration exists because autoIndex is off outside tests.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261117031415,
  name: 'ensure assistant brief index',

  up: async () => {
    await AssistantBriefModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping this one would put brief reads on a collection scan.
  },
};

export default migration;
