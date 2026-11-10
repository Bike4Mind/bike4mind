import { DataLakeResearchConfigModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Adds the trusted/review/unlisted source tiers to research configs written with the single allow
 * list. A non-empty `allowedDomains` becomes the review list with other sites dropped; an empty one
 * sends other sites to review. `allowedDomains` is never unset: code that predates the tiers still
 * reads it, and readers upgrade any document this misses. Run snapshots are history and stay as
 * they are. Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), like its siblings.
 *
 * Idempotent: only documents with no `unlistedSources` are written. Runs on the raw collection so
 * `updatedAt` is left alone.
 */
const migration: MigrationFile = {
  id: 20260921240060,
  name: 'research config source tiers',

  up: async () => {
    const hasAllowed = { $gt: [{ $size: { $ifNull: ['$allowedDomains', []] } }, 0] };
    const result = await DataLakeResearchConfigModel.collection.updateMany({ unlistedSources: { $exists: false } }, [
      {
        $set: {
          trustedDomains: [],
          reviewDomains: { $cond: [hasAllowed, '$allowedDomains', []] },
          unlistedSources: { $cond: [hasAllowed, 'drop', 'review'] },
        },
      },
    ]);
    console.log(`[research-config-source-tiers] upgraded ${result.modifiedCount} config(s)`);
  },

  down: async () => {
    await DataLakeResearchConfigModel.collection.updateMany({}, [
      { $unset: ['trustedDomains', 'reviewDomains', 'unlistedSources'] },
    ]);
  },
};

export default migration;
