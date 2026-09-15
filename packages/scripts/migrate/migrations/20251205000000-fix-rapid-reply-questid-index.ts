import { RapidReplyResultModel, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251205000000,
  name: 'Fix RapidReplyResult questId index to be sparse',

  up: async () => {
    console.log('Starting migration: Fixing RapidReplyResult questId index...');

    try {
      const collection = RapidReplyResultModel.collection;

      console.log('Dropping old questId index...');
      await safeDropIndex(collection, 'questId_1');

      // Recreate indexes (including the new sparse questId index)
      console.log('Creating new sparse questId index...');
      await RapidReplyResultModel.createIndexes();
      console.log('✅ New sparse questId index created');

      console.log('✅ Migration complete - questId index is now sparse (allows multiple null values)');
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Rolling back: Reverting questId index to non-sparse...');

    try {
      const collection = RapidReplyResultModel.collection;

      console.log('Dropping sparse questId index...');
      await safeDropIndex(collection, 'questId_1');

      console.log('Creating non-sparse questId index...');
      await collection.createIndex({ questId: 1 });
      console.log('✅ Non-sparse questId index created');

      console.log('✅ Rollback complete - questId index reverted to non-sparse');
    } catch (error) {
      console.error('❌ Rollback failed:', error);
      throw error;
    }
  },
};

export default migration;
