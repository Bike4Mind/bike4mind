import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ 'derivedFrom.fileId': 1, deletedAt: 1 }` index exists on fabfiles.
 *
 * It serves the reverse lineage lookup ("what was made from this file") over generated files, and only
 * tool-generated rows carry an entry.
 *
 * Migration rather than autoIndex, for the same reason as 20260921235994_ensure-fabfile-owned-keyset-index:
 * autoIndex builds are fire-and-forget (a failure is silent), and left to autoIndex
 * it would build on whichever Lambda's cold boot touches fabfiles first after deploy.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235976,
  name: 'ensure fabfile derived from index',

  up: async () => {
    await FabFile.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
