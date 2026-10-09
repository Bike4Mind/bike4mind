import { ApiKeyUsageLog } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ source, ownerType, timestamp }` index exists on apikeyusagelogs.
 *
 * The admin platform-usage endpoint section filters ApiKeyUsageLog by the source and owner type
 * stamped at request time (ApiKeyUsageLogRepository.platformEndpointUsage); this index serves that
 * match over the trailing window instead of scanning the collection.
 *
 * Migration rather than autoIndex for the reason in 20260902000000_ensure-quest-retrieval-index:
 * prod runs DocumentDB, where an index build takes a foreground collection lock, and autoIndex
 * would take it on whichever request cold-boots onto this collection first. Id backdated below
 * BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), whose test asserts it has the
 * highest id on disk.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and also backfills any of
 * this model's other declared indexes an environment is missing.
 */
const migration: MigrationFile = {
  id: 20260921235995,
  name: 'ensure api key usage log source and owner type index',

  up: async () => {
    await ApiKeyUsageLog.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
