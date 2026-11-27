import { AdminRoleModel, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the admin role indexes exist: the case-insensitive unique `adminRole_name_ci` on adminroles
 * (packages/database/src/models/infra/admin/AdminRoleModel.ts) and `user_adminRoleIds` on users,
 * which serves member counts and lookups by role.
 *
 * Migration rather than autoIndex, as 20260921236100_ensure-admin-saved-view-indexes: an autoIndex
 * build is fire-and-forget, so a failed unique index would silently allow duplicate role names.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and the names match the schemas.
 */
const migration: MigrationFile = {
  id: 20261114140117,
  name: 'ensure admin role indexes',

  up: async () => {
    await AdminRoleModel.createIndexes();
    await User.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
