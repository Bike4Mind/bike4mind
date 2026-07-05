import { convertId, FabFile, fileTagRepository, User } from '@bike4mind/database';
import { type MigrationFile } from './index';
import mongoose from 'mongoose';

/**
 * Recalculate and fix a user's currentStorageSize based on their non-deleted FabFiles.
 * @param userId - The user's ObjectId (string or ObjectId)
 * @returns The recalculated storage size in bytes
 */
export async function fixUserStorageSize(userId: string | mongoose.Types.ObjectId): Promise<number> {
  const userObjectId = convertId(userId);

  // Only sum fileSize for non-deleted FabFiles
  const files = await FabFile.find({ userId: userObjectId, deletedAt: null }, 'fileSize');
  const totalSize = files.reduce((sum, file) => sum + (file.fileSize || 0), 0);

  // Update only if different
  const user = await User.findById(userObjectId);
  if (user && user.currentStorageSize !== totalSize) {
    user.currentStorageSize = totalSize;
    await user.save();
  }
  return totalSize;
}

const migration: MigrationFile = {
  id: 20250630185100,
  name: 'fix user storage size',

  up: async () => {
    // Find all deleted FabFiles with tags
    const deletedFilesWithTags = await FabFile.find(
      { deletedAt: { $ne: null }, tags: { $exists: true, $not: { $size: 0 } } },
      { userId: 1, tags: 1 }
    );

    for (const file of deletedFilesWithTags) {
      for (const tag of file.tags || []) {
        // Decrement fileCount for this tag and user
        await fileTagRepository.incrementFileCountBy({ name: tag.name, userId: file.userId }, -1);
      }
    }

    // Now clear the tags array as before
    await FabFile.updateMany(
      { deletedAt: { $ne: null }, tags: { $exists: true, $not: { $size: 0 } } },
      { $set: { tags: [] } }
    );

    // Find all users with currentStorageSize > 0 or < 0
    const users = await User.find(
      { $or: [{ currentStorageSize: { $gt: 0 } }, { currentStorageSize: { $lt: 0 } }] },
      '_id currentStorageSize username email'
    );
    const negativeCount = users.filter(u => u.currentStorageSize < 0).length;
    let updatedCount = 0;
    let unchangedCount = 0;
    const totalCount = users.length;

    console.log(`Found ${totalCount} users with currentStorageSize > 0 or < 0`);
    if (negativeCount > 0) {
      console.log(`Found ${negativeCount} users with negative currentStorageSize (will be fixed).`);
    }

    for (const user of users) {
      const before = user.currentStorageSize;
      const after = await fixUserStorageSize(user.id);
      if (before !== after) {
        updatedCount++;
        console.log(`User ${user.username || user.email || user._id}: storage corrected from ${before} to ${after}`);
      } else {
        unchangedCount++;
        console.log(`User ${user.username || user.email || user._id}: storage already correct at ${before}`);
      }
    }
    console.log(
      `Migration summary: ${totalCount} users processed, ${updatedCount} updated, ${unchangedCount} unchanged.`
    );
  },

  down: async () => {
    // We can't revert this migration, so we'll just log a message
    console.log('This migration cannot be reverted.');
  },
};

export default migration;
