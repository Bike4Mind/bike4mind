import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ nextBriefAt: 1 }` index on users, which serves the brief-schedule reconciler's
 * due scan. Only users with a brief schedule on carry the field, so the index stays small. Built directly
 * rather than via createIndexes so this migration builds no other pending user index.
 *
 * Idempotent: createIndex is a no-op when the same index already exists.
 */
const migration: MigrationFile = {
  id: 20261118073238,
  name: 'ensure user next brief at index',

  up: async () => {
    await User.collection.createIndex(
      { nextBriefAt: 1 },
      { name: 'user_nextBriefAt', partialFilterExpression: { nextBriefAt: { $type: 'date' } } }
    );
  },

  down: async () => {
    // Indexes are additive; dropping this one would put the due scan on a collection scan.
  },
};

export default migration;
