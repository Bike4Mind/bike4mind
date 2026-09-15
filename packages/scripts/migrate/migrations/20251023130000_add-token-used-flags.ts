import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: Add token used flags to prevent token reuse
 *
 * Security flags against token-reuse attacks:
 * - emailVerificationUsed: prevents email verification token reuse
 * - pendingEmailUsed: prevents email change token reuse
 *
 * Guards against race conditions where a token could be used multiple
 * times before the database update completes.
 */

const migration: MigrationFile = {
  id: 20251023130000,
  name: 'add token used flags',

  up: async () => {
    console.log('Adding token used flags to User collection...');

    try {
      // Add emailVerificationUsed field (default null, will be set to true when used)
      await User.collection.updateMany(
        { emailVerificationUsed: { $exists: false } },
        { $set: { emailVerificationUsed: null } }
      );
      console.log('✓ Added emailVerificationUsed field');

      // Add pendingEmailUsed field (default null, will be set to true when used)
      await User.collection.updateMany({ pendingEmailUsed: { $exists: false } }, { $set: { pendingEmailUsed: null } });
      console.log('✓ Added pendingEmailUsed field');

      console.log('✓ Token used flags added successfully');
    } catch (error) {
      console.error('Error adding token used flags:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Removing token used flags from User collection...');

    try {
      await User.collection.updateMany({}, { $unset: { emailVerificationUsed: '' } });
      console.log('✓ Removed emailVerificationUsed field');

      await User.collection.updateMany({}, { $unset: { pendingEmailUsed: '' } });
      console.log('✓ Removed pendingEmailUsed field');

      console.log('✓ Token used flags removed successfully');
    } catch (error) {
      console.error('Error removing token used flags:', error);
      throw error;
    }
  },
};

export default migration;
