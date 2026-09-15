import { FabFile } from '@bike4mind/database';
import { Permission } from '@bike4mind/common';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250715000000,
  name: 'add share permissions to existing users',

  up: async () => {
    console.log('🚀 Starting migration: Add share permissions to existing shared files');

    // Find all FabFiles that have users array with at least one user
    const fabFilesWithUsers = await FabFile.find({
      users: { $exists: true, $ne: [], $type: 'array' },
      type: { $exists: true },
    });

    console.log(`📁 Found ${fabFilesWithUsers.length} files with shared users to check`);

    let totalUsersUpdated = 0;
    let filesUpdated = 0;

    for (const fabFile of fabFilesWithUsers) {
      if (!fabFile.users || !Array.isArray(fabFile.users) || fabFile.users.length === 0) {
        continue;
      }

      // First, validate that all users have required fields
      const hasInvalidUsers = fabFile.users.some(user => !user.userId || !user.permissions);
      if (hasInvalidUsers) {
        console.log(`⏭️ Skipping file "${fabFile.fileName}" - contains users with missing userId or permissions`);
        continue;
      }

      let fileModified = false;
      let usersUpdatedInFile = 0;

      // Check each user in the users array (these are people who received shares)
      for (const userShare of fabFile.users) {
        // Only add share permission if:
        // 1. They have read permission (were properly shared with) - covers read, read+write, etc.
        // 2. They don't already have share permission
        // 3. They are NOT the file owner (owner is in userId field, not users array)
        const hasReadPermission = userShare.permissions.includes(Permission.read);
        const hasSharePermission = userShare.permissions.includes(Permission.share);
        const isNotOwner = userShare.userId !== fabFile.userId;

        if (hasReadPermission && !hasSharePermission && isNotOwner) {
          userShare.permissions.push(Permission.share);
          fileModified = true;
          usersUpdatedInFile++;
          totalUsersUpdated++;

          console.log(
            `  👤 Added share permission to user ${userShare.userId} for file "${fabFile.fileName}" (permissions: ${JSON.stringify(userShare.permissions)})`
          );
        } else {
          if (!hasReadPermission) {
            console.log(
              `  ⏭️  Skipping user ${userShare.userId} for file "${fabFile.fileName}" - no read permission (has: ${JSON.stringify(userShare.permissions)})`
            );
          } else if (hasSharePermission) {
            console.log(
              `  ⏭️  Skipping user ${userShare.userId} for file "${fabFile.fileName}" - already has share permission (has: ${JSON.stringify(userShare.permissions)})`
            );
          } else if (!isNotOwner) {
            console.log(`  ⏭️  Skipping user ${userShare.userId} for file "${fabFile.fileName}" - is file owner`);
          }
        }
      }

      if (fileModified) {
        await fabFile.save();
        filesUpdated++;
        console.log(`📄 Updated file "${fabFile.fileName}" (${usersUpdatedInFile} users)`);
      }
    }

    console.log('✅ Migration completed successfully!');
    console.log(`📊 Summary:`);
    console.log(`   - Files updated: ${filesUpdated}`);
    console.log(`   - Total users updated: ${totalUsersUpdated}`);
    console.log(`   - Only users who received shared files (not file owners) were updated`);
  },

  down: async () => {
    console.log('🔄 Rolling back: Remove share permissions from users');

    // Find all FabFiles that have users with 'share' permission
    const fabFilesWithUsers = await FabFile.find({
      users: { $exists: true, $ne: [], $type: 'array' },
      'users.permissions': Permission.share,
    });

    console.log(`📁 Found ${fabFilesWithUsers.length} files with users to check`);

    let totalUsersUpdated = 0;
    let filesUpdated = 0;

    for (const fabFile of fabFilesWithUsers) {
      if (!fabFile.users || !Array.isArray(fabFile.users)) {
        continue;
      }

      // First, validate that all users have required fields
      const hasInvalidUsers = fabFile.users.some(user => !user.userId || !user.permissions);
      if (hasInvalidUsers) {
        console.log(`⏭️ Skipping file "${fabFile.fileName}" - contains users with missing userId or permissions`);
        continue;
      }

      let fileModified = false;
      let usersUpdatedInFile = 0;

      // Remove 'share' permission from each user (but keep other permissions)
      for (const userShare of fabFile.users) {
        const shareIndex = userShare.permissions.indexOf(Permission.share);
        if (shareIndex > -1) {
          // Only remove share permission if they have other permissions too
          // (to avoid leaving users with empty permissions array)
          if (userShare.permissions.length > 1) {
            userShare.permissions.splice(shareIndex, 1);
            fileModified = true;
            usersUpdatedInFile++;
            totalUsersUpdated++;
          }
        }
      }

      if (fileModified) {
        await fabFile.save();
        filesUpdated++;
        console.log(`📄 Rolled back file "${fabFile.fileName}" (${usersUpdatedInFile} users)`);
      }
    }

    console.log('✅ Rollback completed successfully!');
    console.log(`📊 Summary:`);
    console.log(`   - Files updated: ${filesUpdated}`);
    console.log(`   - Total users updated: ${totalUsersUpdated}`);
  },
};

export default migration;
