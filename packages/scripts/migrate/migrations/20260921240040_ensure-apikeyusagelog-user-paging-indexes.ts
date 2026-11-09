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
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921240040,
  name: 'ensure api key usage log user paging indexes',

  up: async () => {
    await ApiKeyUsageLog.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
