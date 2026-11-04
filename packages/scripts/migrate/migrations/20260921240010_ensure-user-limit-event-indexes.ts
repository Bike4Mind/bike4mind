import { UserLimitEventModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the UserLimitEvent indexes: the unique per-user/kind/hour key its upserts rely on, the
 * timeline's keyset index, and the 90-day TTL. `autoIndex` is off in the deployed environments, so
 * without this migration none of them builds. Id backdated below the fail-closed OAuth backfill.
 *
 * Idempotent: createIndexes is a no-op for indexes that already match.
 */
const migration: MigrationFile = {
  id: 20260921240010,
  name: 'ensure user limit event indexes',

  up: async () => {
    await UserLimitEventModel.createIndexes();
  },

  down: async () => {
    await UserLimitEventModel.collection.drop();
  },
};

export default migration;
