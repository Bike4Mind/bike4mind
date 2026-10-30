import { AdminSavedView } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the admin saved views indexes exist: the unique {ownerId, surface, name} (one name per
 * admin per list) and {surface, shared} (the shared half of the list query). See
 * packages/database/src/models/infra/admin/AdminSavedViewModel.ts.
 *
 * Migration rather than autoIndex, as 20260921236000_ensure-user-admin-list-indexes: an autoIndex
 * build is fire-and-forget, so a failed unique index would silently allow duplicate names.
 *
 * Id sits below 20260922000001, which must stay the last core migration (see index.ts).
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921236100,
  name: 'ensure admin saved view indexes',

  up: async () => {
    await AdminSavedView.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
