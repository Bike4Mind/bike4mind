import { Quest } from '@bike4mind/database';
import { extractFilename } from '@bike4mind/utils';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251106201805,
  name: 'convert quest images to filenames',

  up: async () => {
    console.log('Starting migration: Converting quest images to filenames...');

    try {
      // Find all quests with images
      const quests = await Quest.find({
        images: { $exists: true, $ne: [] },
      });

      let processedCount = 0;
      let updatedCount = 0;

      for (const quest of quests) {
        let hasChanges = false;
        const newImages = quest.images!.map(image => {
          const filename = extractFilename(image);
          if (filename !== image) {
            hasChanges = true;
          }
          return filename;
        });

        if (hasChanges) {
          quest.images = newImages;
          await quest.save();
          updatedCount++;
        }

        processedCount++;

        if (processedCount % 100 === 0) {
          console.log(`  Processed ${processedCount} quests...`);
        }
      }

      console.log(`✅ Migration completed.`);
      console.log(`   - Processed: ${processedCount} quests`);
      console.log(`   - Updated: ${updatedCount} quests`);
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('⚠️  Cannot rollback: Original URL information was not preserved.');
    console.log('   This migration is irreversible.');
    console.log('   Restore from database backup if needed.');
  },
};

export default migration;
