import { SkillListing, assignClaudePluginName } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[backfill-skilllisting-claude-plugin-name]';

/**
 * Name every approved Organization listing that predates `claudePluginName`. Oldest first through
 * the same helper the approve path uses, so of two same-named listings the older keeps the bare
 * slug. Builds the indexes first: the unique `(organizationId, claudePluginName)` index is what turns
 * a collision into the id-suffixed fallback, and EnsureSkillListingIndexes already ran on most stages.
 *
 * Idempotent: named listings are skipped and the helper never overwrites.
 */
const migration: MigrationFile = {
  id: 20260921235963,
  name: 'backfill-skilllisting-claude-plugin-name',

  up: async () => {
    await SkillListing.createIndexes();
    const listings = await SkillListing.find({
      visibility: 'organization',
      currentApprovedVersionId: { $ne: null },
      claudePluginName: { $exists: false },
    })
      .sort({ _id: 1 })
      .select('_id name');
    let failed = 0;
    for (const listing of listings) {
      try {
        await assignClaudePluginName(String(listing._id), listing.name);
      } catch (err) {
        // Don't stall the migration chain; the Claude Code feed names leftovers on its next build.
        failed++;
        console.error(`${LOG} failed to name ${listing._id}`, err);
      }
    }
    console.log(`${LOG} named ${listings.length - failed} listing(s), ${failed} failed`);
  },

  // No-op: a name is harmless to the old code, and unsetting it would let a re-run assign a
  // different one, breaking installs keyed on it.
  down: async () => {},
};

export default migration;
