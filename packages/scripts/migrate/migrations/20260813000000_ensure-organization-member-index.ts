import { Organization } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ 'users.userId': 1 }` exists on organizations.
 *
 * Lake authorization now resolves a caller's org-membership set on every data-lake request
 * (findMembershipOrgIds, #1674); without this index the users[] ACL arm collscans. Declared on
 * the schema too, but autoIndex builds lazily on a cold boot - a request-path dependency
 * belongs in a migration (same rationale as 20260728000000_ensure-fabfilechunk-keyset-index).
 *
 * Idempotent: createIndexes is a no-op for existing indexes; it also builds the two
 * pre-existing declared indexes if an environment somehow lacks them.
 */
const migration: MigrationFile = {
  id: 20260813000000,
  name: 'ensure organization member index',

  up: async () => {
    await Organization.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
