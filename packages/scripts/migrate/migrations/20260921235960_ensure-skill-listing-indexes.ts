import { SkillListing, SkillListingImport, SkillListingReport, SkillListingVersion } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the Skill Market collections' indexes.
 *
 * Several are correctness-bearing: the partial unique `{authorUserId, sourceSkillId}` index on
 * active listings is what stops two concurrent publishes of one skill from both landing, and the
 * unique `shareToken` and `(listingId, userId)` indexes back the unlisted link and the one-row-per-
 * importer rule. Left to autoIndex they build fire-and-forget on whichever Lambda cold-boots onto
 * the collection first, and a failure is silent.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235960,
  name: 'ensure skill listing indexes',

  up: async () => {
    await SkillListing.createIndexes();
    await SkillListingVersion.createIndexes();
    await SkillListingImport.createIndexes();
    await SkillListingReport.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
