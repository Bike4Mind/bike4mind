import { GrantPackage, GrantPackageDayCount, GrantPackageRedemption } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the unique indexes behind grant packages exist.
 *
 * The (packageId, userId) unique index on redemptions is what makes the redeem dedupe (E11000) hold,
 * and the (packageId, day) unique index on day counts is what keeps the daily cap a single counter
 * per package-day. `autoIndex` is fire-and-forget (and off in deployed environments), so without
 * this the constraints those paths rely on may never be built. Id sorts below
 * BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay last.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921238500,
  name: 'ensure grant package indexes',

  up: async () => {
    await GrantPackage.createIndexes();
    await GrantPackageRedemption.createIndexes();
    await GrantPackageDayCount.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping the unique ones would let the cap and dedupe silently break.
  },
};

export default migration;
