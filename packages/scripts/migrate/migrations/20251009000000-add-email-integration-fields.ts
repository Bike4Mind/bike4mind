import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251009000000,
  name: 'Add email integration fields to UserModel for Email-to-Platform Ingestion',

  up: async () => {
    console.log('Starting migration: Adding platformEmailAddress and authorizedEmailAddresses to users...');

    try {
      const collection = User.collection;

      try {
        await collection.createIndex(
          { platformEmailAddress: 1 },
          { unique: true, sparse: true, name: 'platformEmailAddress_1' }
        );
        console.log('✅ Created index on platformEmailAddress');
      } catch (error) {
        console.log('⚠️  platformEmailAddress index may already exist');
      }

      // Set default empty array for authorizedEmailAddresses on existing users
      // (New users will get default [] from schema)
      const updateResult = await collection.updateMany(
        { authorizedEmailAddresses: { $exists: false } },
        { $set: { authorizedEmailAddresses: [] } }
      );

      console.log(`✅ Updated ${updateResult.modifiedCount} users with default authorizedEmailAddresses`);
      console.log('✅ Migration complete - Email integration fields added');
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Rolling back: Removing email integration fields from users...');

    try {
      const collection = User.collection;

      try {
        await collection.dropIndex('platformEmailAddress_1');
        console.log('✅ Dropped platformEmailAddress index');
      } catch (error) {
        console.log('⚠️  platformEmailAddress index may not exist');
      }

      const updateResult = await collection.updateMany(
        {},
        {
          $unset: {
            platformEmailAddress: '',
            authorizedEmailAddresses: '',
          },
        }
      );

      console.log(`✅ Removed email integration fields from ${updateResult.modifiedCount} users`);
      console.log('✅ Rollback complete');
    } catch (error) {
      console.error('❌ Rollback failed:', error);
      throw error;
    }
  },
};

export default migration;
