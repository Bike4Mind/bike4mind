import { OrgGitHubLakeConnection } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the OrgGitHubLakeConnection indexes before the first connect can write a row.
 *
 * The unique repositoryId and targetDataLakeId indexes are the one-repo-per-lake / one-lake-per-repo
 * claims, not a speed hint: without them two concurrent connects can both insert. autoIndex builds
 * are fire-and-forget on cold boot and fail silently, so the claims are built here instead. The
 * collection is new, so the build is instant.
 *
 * The id is back-dated below 20260922000001 on purpose: that fail-closed backfill must sort after
 * every other core migration (guarded by its test) so its throw blocks only itself.
 */
const migration: MigrationFile = {
  id: 20260921235959,
  name: 'ensure org github lake connection indexes',

  up: async () => {
    await OrgGitHubLakeConnection.createIndexes();
  },

  down: async () => {
    // Dropping the unique claims would let two lakes bind one repository. Removal, if ever wanted, is
    // a deliberate forward migration.
  },
};

export default migration;
