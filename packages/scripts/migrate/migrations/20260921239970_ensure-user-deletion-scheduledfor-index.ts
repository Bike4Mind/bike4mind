import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `user_deletion_scheduledFor` index exists on users.
 *
 * Serves the account deletion purge job's scan for grace periods that have ended
 * (User.deletion.scheduledFor, set by apps/client/server/users/accountDeletion.ts).
 *
 * Migration rather than autoIndex for the reason given in 20260918010000_ensure-user-organizationid-index.
 * Key, name and options must match the UserModel.ts declaration byte-for-byte, or this build and autoIndex
 * hit an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260921239970,
  name: 'ensure user deletion scheduledFor index',

  up: async () => {
    await User.collection.createIndex(
      { 'deletion.scheduledFor': 1 },
      { partialFilterExpression: { 'deletion.scheduledFor': { $type: 'date' } }, name: 'user_deletion_scheduledFor' }
    );
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the purge scan back on a collection scan.
    // Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
