import { SkillListingTemplate } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the template page collection's indexes. Both are correctness-bearing: the unique `listingId`
 * keeps one template per listing and the unique `slug` keeps each public page link unambiguous, so
 * they are not left to autoIndex. Idempotent: createIndexes is a no-op for indexes that exist.
 */
const migration: MigrationFile = {
  id: 20261120062415,
  name: 'ensure skill listing template indexes',

  up: async () => {
    await SkillListingTemplate.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
