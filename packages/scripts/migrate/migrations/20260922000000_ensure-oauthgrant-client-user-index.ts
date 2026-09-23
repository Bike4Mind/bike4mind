import { OAuthGrantModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the unique (clientId, userId) index behind OAuthGrant.
 *
 * The grant is the record of a user's consent to a relying-party client, and both the authorize
 * flow (upsertGrant) and revoke() assume exactly one row per pair. `autoIndex` is off in the
 * deployed environments, so the `OAuthGrantSchema.index({ clientId, userId }, { unique: true })`
 * declaration never actually builds there. Without this migration two concurrent initial consents
 * can create duplicate grants; the constraint that lets upsertGrant's E11000 retry collapse the
 * race, and that keeps revoke() from hiding only one of two rows, would simply not exist.
 *
 * Must run before the first relying-party consent write reaches a deployed database - once
 * duplicate grants exist this becomes data cleanup rather than a cheap schema build.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260922000000,
  name: 'ensure oauthgrant client-user unique index',

  up: async () => {
    await OAuthGrantModel.createIndexes();
  },

  down: async () => {
    // One-way. Dropping it would let duplicate grants accumulate and break revoke()/upsert.
  },
};

export default migration;
