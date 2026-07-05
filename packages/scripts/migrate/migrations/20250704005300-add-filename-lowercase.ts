import { FabFile } from '@bike4mind/database';
import { migrateLowercaseFields } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250704005300,
  name: 'Add fileNameLower field to FabFile documents for DocumentDB compatibility',

  up: async () => {
    console.log('Starting migration: Adding fileNameLower field to FabFile documents...');

    try {
      const processed = await migrateLowercaseFields(FabFile, ['fileName'], 100);
      console.log(`✅ Migration completed successfully. Processed ${processed} documents.`);
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Rolling back: Removing fileNameLower field from FabFile documents...');

    try {
      const result = await FabFile.updateMany({ fileNameLower: { $exists: true } }, { $unset: { fileNameLower: 1 } });
      console.log(`✅ Rollback completed. Removed fileNameLower from ${result.modifiedCount} documents.`);
    } catch (error) {
      console.error('❌ Rollback failed:', error);
      throw error;
    }
  },
};

export default migration;
