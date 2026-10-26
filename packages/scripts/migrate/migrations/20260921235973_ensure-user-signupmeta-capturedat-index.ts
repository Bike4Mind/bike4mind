import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `user_signupMeta_capturedAt` index exists on users.
 *
 * The daily signupIpRetention cron (apps/workers/src/cron/signupIpRetention.ts) looks up users
 * whose `signupMeta.capturedAt` is past the retention window. Without this index that read scans
 * the whole users collection every day.
 *
 * Migration rather than autoIndex for the reason given in
 * 20260918010000_ensure-user-organizationid-index: prod runs DocumentDB, where an index build on
 * users takes a foreground collection lock, so the build should run at a chosen moment.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. The name matches the schema
 * declaration byte-for-byte, so this build and autoIndex cannot produce an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260921235973,
  name: 'ensure user signupMeta capturedAt index',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the retention sweep back on a
    // collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
