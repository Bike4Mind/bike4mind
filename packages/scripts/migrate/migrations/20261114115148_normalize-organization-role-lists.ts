import { Organization } from '@bike4mind/database';
import { type MigrationFile } from './index';

type OrganizationRow = {
  userId: string;
  adminUserIds?: string[] | null;
  billingManagerUserIds?: string[] | null;
};

const BILLING_MANAGER_INDEX_KEY = { billingManagerUserIds: 1 } as const;

/**
 * Move every organization onto the role model (b4m-core/common/src/constants/orgRoles.ts), where a
 * user's role comes from the first match of: owner (`userId`), Manager (`adminUserIds`), Billing
 * manager (`billingManagerUserIds`), Member.
 *
 * - Existing owners stay Owner and existing managers stay Manager; that is the mapping, and the role
 *   table grants each exactly what the owner-only and owner-or-manager gates granted before.
 * - `billingManagerUserIds` starts empty everywhere, so nobody gains the new role.
 * - An owner also listed in `adminUserIds` keeps the entry. Owner resolves first, so it grants
 *   nothing today, but transferOwnership leaves it in place and the former owner stays a Manager.
 * - A stored `null` for either list becomes `[]`, so `$addToSet`/`$pull` writes against it succeed.
 * - The `{ billingManagerUserIds: 1 }` index is built here rather than left to autoIndex (off in
 *   deployed envs), because the account-erasure `$or` (purgeAccountContent) only index-unions when
 *   every arm is indexed.
 *
 * Raw collection, so soft-deleted orgs are normalized too. Idempotent: every write is filtered to
 * the rows it would change. Id backdated below 20260922000000 so
 * BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) stays last.
 */
const migration: MigrationFile = {
  id: 20261114115148,
  name: 'normalize organization role lists',

  up: async () => {
    const organizations = Organization.db.collection<OrganizationRow>(Organization.collection.collectionName);

    const billingInitialized = await organizations.updateMany(
      { billingManagerUserIds: null },
      { $set: { billingManagerUserIds: [] } }
    );
    const adminsInitialized = await organizations.updateMany({ adminUserIds: null }, { $set: { adminUserIds: [] } });

    await organizations.createIndex(BILLING_MANAGER_INDEX_KEY);

    console.log(
      `[normalize-organization-role-lists] billingManagerUserIds initialized on ${billingInitialized.modifiedCount}, ` +
        `adminUserIds initialized on ${adminsInitialized.modifiedCount}`
    );
  },

  down: async () => {
    // Nothing to restore: an empty role list is what the schema default reads as anyway.
  },
};

export default migration;
