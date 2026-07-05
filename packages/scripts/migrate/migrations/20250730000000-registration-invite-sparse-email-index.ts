import { RegistrationInvite } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250730000000,
  name: 'Remove email index from registration invites for DocumentDB compatibility',

  up: async () => {
    console.log('Starting migration: Removing email index from registration invites...');

    try {
      const collection = RegistrationInvite.collection;

      // Drop the existing unique index on email if it exists
      try {
        await collection.dropIndex('email_1');
        console.log('✅ Dropped email index successfully');
      } catch (error) {
        console.log('No existing email index to drop (this is expected if already removed)');
      }

      // Not creating a new email index: DocumentDB does not properly support sparse
      // unique indexes like MongoDB. The 'code' field ensures per-invite uniqueness.

      console.log('✅ Migration complete - email field no longer has unique constraint');
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Rolling back: No action needed (email index remains removed)');
    // Not recreating the unique index: it would break DocumentDB compatibility again.
    console.log('✅ Rollback complete');
  },
};

export default migration;
