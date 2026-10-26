import { AuthEventModel, Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `signupActivity_user_status_startedAt` index exists on quests.
 *
 * The signup-grant activity check aggregates a user's qualifying session turns by
 * `{ 'signupActivity.userId', status, 'signupActivity.startedAt' }`; the index keeps that
 * aggregate (3s maxTimeMS) off a scan of the largest collection in the database.
 * Also build the network signup-count indexes added to AuthEvent. The earlier
 * ensure-authevent-indexes migration may already have run before these keys existed.
 *
 * Migration rather than autoIndex, for the same reason as 20260917000200_ensure-quest-corrects-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock, and autoIndex
 * would run it on whichever Lambda's cold boot first touches quests after deploy.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. The index name matches the
 * schema declaration, so this build and autoIndex cannot produce an IndexKeySpecsConflict. Id is
 * backdated below the fail-closed OAuth backfill, which must stay the highest id on disk.
 */
const migration: MigrationFile = {
  id: 20260921235966,
  name: 'ensure quest signup activity index',

  up: async () => {
    await Quest.createIndexes();
    await AuthEventModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
