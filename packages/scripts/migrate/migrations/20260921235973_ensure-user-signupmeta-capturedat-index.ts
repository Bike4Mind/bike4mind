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
 * Builds only this index, not every missing User index, so no unrelated build takes the lock.
 * Idempotent: createIndex is a no-op when the index exists. Key, name and options must match the
 * UserModel.ts declaration byte-for-byte, or this build and autoIndex hit an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260921235973,
  name: 'ensure user signupMeta capturedAt index',

  up: async () => {
    await User.collection.createIndex(
      { 'signupMeta.capturedAt': 1 },
      { name: 'user_signupMeta_capturedAt', sparse: true }
    );
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the retention sweep back on a
    // collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
