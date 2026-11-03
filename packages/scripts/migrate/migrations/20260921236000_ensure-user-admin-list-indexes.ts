import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the admin users list indexes exist on users: createdAt, lastActiveAt and currentCredits
 * each compound with _id (the Signed up, Last active and Credits sorts, which carry an _id
 * tiebreak), isBanned (partial, the Suspended view count) and signupGrantAssessment.band (sparse,
 * the High risk view and filter). See apps/client/server/admin/usersList/listAdminUsers.ts.
 *
 * Migration rather than autoIndex, for the same reason as
 * 20260902000000_ensure-quest-retrieval-index: autoIndex builds are fire-and-forget, so a failure
 * is silent and the build lands on whichever cold boot touches users first. The earlier
 * ensure-user migrations will not pick these up: selectPending skips ids already applied.
 *
 * Id sits below 20260922000001, which must stay the last core migration (see index.ts).
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and it backfills any other
 * declared User index an environment is missing.
 */
const migration: MigrationFile = {
  id: 20260921236000,
  name: 'ensure user admin list indexes',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
