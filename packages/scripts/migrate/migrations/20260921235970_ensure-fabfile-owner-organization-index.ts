import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ organizationId, deletedAt }` index exists on fabfiles.
 *
 * The org storage reconciliation sums an org's charged files (fabFileRepository.sumFileSizeByOrganizationId)
 * once per org per run; without this index each sum scans the collection.
 *
 * Migration rather than autoIndex, for the same reason as 20260921235994_ensure-fabfile-owned-keyset-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock on a cold Lambda boot.
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235970,
  name: 'ensure fabfile owner organization index',

  up: async () => {
    await FabFile.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
