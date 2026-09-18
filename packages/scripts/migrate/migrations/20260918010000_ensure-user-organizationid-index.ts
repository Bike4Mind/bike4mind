import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `user_organizationId` index exists on users.
 *
 * OrganizationRepository.findMemberUserIds reads `User.find({ organizationId })` to resolve the
 * stamp arm of the org member population, and every org feedback report, drill-down page and
 * drill-down item request goes through it. The field carried no index, so each of those requests
 * scanned the whole users collection.
 *
 * Migration rather than autoIndex, for the same reason as
 * 20260918000000_ensure-feedback-org-createdat-index: prod runs DocumentDB, where an index build
 * takes a foreground collection lock, and users is the hottest collection in the system - leaving
 * the build to whichever Lambda cold-boots first after deploy would take that lock at an arbitrary
 * moment rather than a chosen one.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. The name matches the schema
 * declaration byte-for-byte, so this build and autoIndex cannot produce an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260918010000,
  name: 'ensure user organizationId index',

  up: async () => {
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the org member lookup back on a
    // collection scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
