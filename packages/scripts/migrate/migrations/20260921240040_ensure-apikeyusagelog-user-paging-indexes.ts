import { ApiKeyUsageLog } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ userId, keyId, timestamp, _id }` and `{ userId, timestamp, _id }` indexes exist on
 * apikeyusagelogs.
 *
 * They serve the admin user API-request keyset paging (readApiRequests), which filters by user
 * (and optionally key) and pages on timestamp then _id.
 *
 * Migration rather than autoIndex for the reason in 20260921235995_ensure-apikeyusagelog-source-owner-index:
 * autoIndex builds are fire-and-forget and start on whichever request cold-boots first.
 *
 * Then drops the superseded `{ userId, keyId, timestamp }` and `{ userId, timestamp }` indexes, only
 * after the replacements are built.
 *
 * Idempotent: createIndexes is a no-op for existing indexes and a missing old index is tolerated.
 */
const SUPERSEDED_INDEXES = ['userId_1_keyId_1_timestamp_-1', 'userId_1_timestamp_-1'];

const migration: MigrationFile = {
  id: 20260921240040,
  name: 'ensure api key usage log user paging indexes',

  up: async () => {
    await ApiKeyUsageLog.createIndexes();
    for (const name of SUPERSEDED_INDEXES) {
      try {
        await ApiKeyUsageLog.collection.dropIndex(name);
      } catch (error) {
        const e = error as { code?: number; codeName?: string };
        if (e.code !== 27 && e.codeName !== 'IndexNotFound') throw error;
      }
    }
  },

  down: async () => {
    // Dropped indexes are not restored; the replacements cover the same queries.
  },
};

export default migration;
