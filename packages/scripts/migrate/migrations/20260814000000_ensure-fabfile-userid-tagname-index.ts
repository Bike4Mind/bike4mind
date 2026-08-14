import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ userId: 1, 'tags.name': 1, archivedAt: 1, deletedAt: 1 }` exists on fabfiles.
 *
 * computeDataLakeStats's prefix arm (buildDataLakeMembershipFilter) matches on `{ 'tags.name':
 * regex, userId }`, but the only prior index leads with `tags.name`, so the userId conjunct was
 * checked in memory after scanning the whole tag-prefix range. Declared on the schema too, but
 * relying on autoIndex alone would build it lazily on a cold boot of whichever Lambda touches the
 * collection first - a request-path index on a collection this size belongs in a migration, same
 * rationale as 20260728000000_ensure-fabfilechunk-keyset-index and
 * 20260813000001_ensure-organization-member-index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of FabFile's other declared indexes an environment
 * happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260814000000,
  name: 'ensure fabfile userid tagname index',

  up: async () => {
    await FabFile.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
