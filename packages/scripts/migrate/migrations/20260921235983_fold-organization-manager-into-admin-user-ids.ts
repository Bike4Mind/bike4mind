import mongoose from 'mongoose';
import { Organization, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const MANAGER_ID_INDEX_KEY = { managerId: 1 };

/** The raw organization fields this migration touches, so the driver can type the `$push` payloads. */
type OrganizationRow = {
  userId: string;
  seats?: number;
  managerId?: string | null;
  adminUserIds?: string[];
  users?: Array<{ userId: string; permissions: string[] }>;
  userDetails?: Array<{ id: string; email: string; name: string; usedCredits: number; lastCreditUsedAt: Date | null }>;
};

/**
 * Retire the single `organizations.managerId` slot: fold each holder into `adminUserIds` (the
 * owner-edited Managers list every org gate now reads) and drop the field and its index.
 *
 * `managerId` never required a `users[]` row, but a manager's authority does
 * (`isOrgOwnerOrCurrentAdmin` in b4m-core/common/src/constants/organization.ts), so a holder without
 * one is given the same read row, `userDetails` credit row and empty-only `User.organizationId` pointer
 * `addMember` grants. That read row makes them a member (org read scope, switcher, a seat) - the same
 * standing every appointed manager already has. A holder that is the billing owner, or whose user is
 * missing or soft-deleted, is only unset. The seat ceiling is not enforced, since refusing would strand
 * an existing manager; an org pushed over it is logged for follow-up. Neither autoIndex (off in deployed
 * envs) nor createIndexes drops an index the schema stopped declaring, hence the explicit drop.
 *
 * Runs on the raw collection so soft-deleted orgs are folded too. Idempotent: a re-run finds no org
 * with a `managerId`, and every write is guarded against an existing row or entry.
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay last.
 */
const migration: MigrationFile = {
  id: 20260921235983,
  name: 'fold organization manager into admin user ids',

  up: async () => {
    const organizations = Organization.db.collection<OrganizationRow>(Organization.collection.collectionName);
    const holders = await organizations
      .find(
        { managerId: { $nin: [null, ''] } },
        { projection: { _id: 1, userId: 1, managerId: 1, seats: 1, users: 1 } }
      )
      .toArray();

    for (const organization of holders) {
      const managerId = String(organization.managerId);
      const isOwner = String(organization.userId) === managerId;
      const manager =
        isOwner || !mongoose.isValidObjectId(managerId)
          ? null
          : await User.collection.findOne(
              { _id: new mongoose.Types.ObjectId(managerId), deletedAt: { $exists: false } },
              { projection: { email: 1, name: 1, organizationId: 1 } }
            );

      if (manager) {
        await organizations.updateOne({ _id: organization._id }, { $addToSet: { adminUserIds: managerId } });
        const rowAdded = await organizations.updateOne(
          { _id: organization._id, 'users.userId': { $ne: managerId } },
          { $push: { users: { userId: managerId, permissions: ['read'] } } }
        );
        // An existing row with no membership permission would leave the holder a non-member.
        await organizations.updateOne(
          {
            _id: organization._id,
            users: { $elemMatch: { userId: managerId, permissions: { $nin: ['read', 'write'] } } },
          },
          { $addToSet: { 'users.$.permissions': 'read' } }
        );
        // Owner + roster, the count addMember holds below `seats`.
        const seatsUsed = 1 + (organization.users?.length ?? 0) + rowAdded.modifiedCount;
        if (rowAdded.modifiedCount > 0 && organization.seats !== undefined && seatsUsed > organization.seats) {
          console.warn(
            `[fold-organization-manager] org ${String(organization._id)} now uses ${seatsUsed} of ${organization.seats} seats`
          );
        }
        await organizations.updateOne(
          { _id: organization._id, 'userDetails.id': { $ne: managerId } },
          {
            $push: {
              userDetails: {
                id: managerId,
                email: String(manager.email ?? ''),
                name: String(manager.name ?? manager.email ?? ''),
                usedCredits: 0,
                lastCreditUsedAt: null,
              },
            },
          }
        );
        if (!manager.organizationId) {
          await User.collection.updateOne(
            { _id: manager._id, organizationId: null },
            { $set: { organizationId: organization._id } }
          );
        }
      }
      await organizations.updateOne({ _id: organization._id }, { $unset: { managerId: '' } });
    }

    // Orgs that only carry the schema's old `managerId: null` default.
    await organizations.updateMany({ managerId: { $exists: true } }, { $unset: { managerId: '' } });

    const db = Organization.db.db;
    if (!db) throw new Error('No active MongoDB connection - cannot check organizations collection state');
    const collectionExists = (await db.listCollections({ name: organizations.collectionName }).toArray()).length === 1;
    if (collectionExists) {
      const managerIdIndex = (await organizations.indexes()).find(
        index => JSON.stringify(index.key) === JSON.stringify(MANAGER_ID_INDEX_KEY)
      );
      if (managerIdIndex?.name) await organizations.dropIndex(managerIdIndex.name);
    }
  },

  down: async () => {
    // One-way: a single `managerId` cannot be recovered from a list that the owner may since have edited.
  },
};

export default migration;
