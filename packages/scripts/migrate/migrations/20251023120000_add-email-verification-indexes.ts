import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: Add indexes for email verification fields
 *
 * Indexes to optimize email verification queries: token lookups,
 * verification-status filtering, and token-expiration checks.
 */

const migration: MigrationFile = {
  id: 20251023120000,
  name: 'add email verification indexes',

  up: async () => {
    console.log('Creating email verification indexes...');

    const createIndexSafely = async (field: string, options: any) => {
      const indexName = `${field}_1`;

      const existingIndexes = await User.collection.indexes();
      const existingIndex = existingIndexes.find((idx: any) => idx.name === indexName);

      if (existingIndex) {
        // Skip creation to avoid conflicts. Existing indexes in production may have
        // different options; acceptable since the field index is what matters for queries.
        console.log(`✓ Index on ${field} already exists, skipping creation`);
        console.log(`  Existing options: sparse=${existingIndex.sparse}, background=${existingIndex.background}`);
        console.log(`  Requested options: sparse=${options.sparse}, background=${options.background}`);
      } else {
        await User.collection.createIndex({ [field]: 1 }, options);
        console.log(`✓ Created index on ${field}`);
      }
    };

    try {
      // Index for emailVerified field (used for filtering verified/unverified users)
      await createIndexSafely('emailVerified', { background: true });

      // Index for emailVerificationToken (used for token lookups)
      await createIndexSafely('emailVerificationToken', { background: true, sparse: true });

      // Index for emailVerificationExpires (used for checking token expiration)
      await createIndexSafely('emailVerificationExpires', { background: true, sparse: true });

      // Index for pendingEmailToken (used for email change token lookups)
      await createIndexSafely('pendingEmailToken', { background: true, sparse: true });

      // Index for pendingEmailExpires (used for checking email change token expiration)
      await createIndexSafely('pendingEmailExpires', { background: true, sparse: true });

      console.log('✓ All email verification indexes created successfully');
    } catch (error) {
      console.error('Error creating indexes:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Dropping email verification indexes...');

    try {
      // Drop indexes in reverse order
      await User.collection.dropIndex('pendingEmailExpires_1');
      console.log('✓ Dropped index on pendingEmailExpires');

      await User.collection.dropIndex('pendingEmailToken_1');
      console.log('✓ Dropped index on pendingEmailToken');

      await User.collection.dropIndex('emailVerificationExpires_1');
      console.log('✓ Dropped index on emailVerificationExpires');

      await User.collection.dropIndex('emailVerificationToken_1');
      console.log('✓ Dropped index on emailVerificationToken');

      await User.collection.dropIndex('emailVerified_1');
      console.log('✓ Dropped index on emailVerified');

      console.log('✓ All email verification indexes dropped successfully');
    } catch (error) {
      console.error('Error dropping indexes:', error);
      throw error;
    }
  },
};

export default migration;
