import { PhoneUnlockClaim } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the unique `phoneHash` index on phoneunlockclaims exists before the phone unlock is enabled.
 *
 * The index is the only thing that keeps one phone number to one unlock across accounts.
 * phoneUnlockClaimRepository.claim also awaits model.init(), but autoIndex builds are fire-and-forget
 * elsewhere (a failure is silent), so the build belongs in a migration window.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921236500,
  name: 'ensure phone unlock claim index',

  up: async () => {
    await PhoneUnlockClaim.createIndexes();
  },

  down: async () => {
    // Dropping the index would let one number unlock many accounts. Removal is a deliberate forward migration.
  },
};

export default migration;
