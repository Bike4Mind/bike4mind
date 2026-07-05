import { type MigrationFile } from './index';
import { Organization } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20250325153205,
  name: 'Fix existing organization data',

  up: async () => {
    // Legacy organizations lacking a userId field need updating to the new schema.
    const organizations = await Organization.find({ userId: { $exists: false } });

    console.log(`[Migration 20250325153205] Found ${organizations.length} organizations to process`);

    let updatedCount = 0;
    let deletedCount = 0;

    for (const org of organizations) {
      // Legacy orgs had a single owner as the first users entry; promote that user to the userId (owner) field.
      const firstUser = org.users?.[0];

      if (firstUser?.userId) {
        console.log(
          `[Migration 20250325153205] Updating organization ${org._id} - Setting owner to user ${firstUser.userId}`
        );

        // Remove from the users array to avoid duplicate ownership now that userId holds the owner.
        await Organization.updateOne(
          { _id: org._id },
          {
            $set: { userId: firstUser.userId },
            $pull: {
              users: { userId: firstUser.userId },
              userDetails: { id: firstUser.userId },
            },
          }
        );
        updatedCount++;
      } else {
        console.log(`[Migration 20250325153205] Deleting orphaned organization ${org._id} - No valid owner found`);
        // No valid owner means the org is orphaned; delete it.
        await Organization.deleteOne({ _id: org._id });
        deletedCount++;
      }
    }

    console.log(`[Migration 20250325153205] Migration completed:
    - Total organizations processed: ${organizations.length}
    - Organizations updated: ${updatedCount}
    - Organizations deleted: ${deletedCount}`);
  },

  down: async () => {
    console.log('[Migration 20250325153205] Down migration not implemented - Cannot safely revert data changes');
    // Not implemented: reverting would require the removed users array, which orgs changed, prior
    // roles/permissions, and which orgs were deleted - none of which is stored.
  },
};

export default migration;
