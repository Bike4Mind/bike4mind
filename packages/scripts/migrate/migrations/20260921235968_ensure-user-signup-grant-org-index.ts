import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the sparse `signupGrant_unlockedOrgId` index exists on users. It serves the
 * per-organization org_invite unlock cap (apps/client/server/credits/orgInviteUnlock.ts).
 *
 * Migration rather than autoIndex for the same reason as 20260921235966_ensure-quest-signup-activity-index
 * (DocumentDB foreground index builds). Idempotent: createIndexes is a no-op for indexes that already
 * exist, and the name matches the schema declaration. Backdated below the fail-closed OAuth backfill,
 * which must stay the highest id on disk.
 */
const migration: MigrationFile = {
  id: 20260921235968,
  name: 'ensure user signup grant org index',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
