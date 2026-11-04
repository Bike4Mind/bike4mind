import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ organizationId, createdAt }` index over pending client uploads exists on
 * fabfiles: the presign doors sum an org pool's in-flight upload bytes through it
 * (apps/client/server/files/pendingUploads.ts). Migration rather than autoIndex for the reason in
 * 20260921235970_ensure-fabfile-owner-organization-index. Idempotent: createIndexes is a no-op for
 * indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921239600,
  name: 'ensure fabfile pending upload index',

  up: async () => {
    await FabFile.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
