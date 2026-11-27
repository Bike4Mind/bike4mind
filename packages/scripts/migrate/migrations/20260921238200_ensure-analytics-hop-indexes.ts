import { AnalyticsHop } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the unique `hopId` index and the `expiresAt` TTL index exist on analytics_hops.
 *
 * The unique index is what keeps one hop id to one record, so the single-use redeem (a conditional
 * update on `redeemedAt: null`) cannot be split across two copies. The TTL index is the record's
 * retention. Left to autoIndex, the build is fire-and-forget. Id backdated below
 * BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), like its index-migration siblings.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921238200,
  name: 'ensure analytics hop indexes',

  up: async () => {
    await AnalyticsHop.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping the unique one would let a hop id be stored twice.
  },
};

export default migration;
