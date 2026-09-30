import { OAuthGrantModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the compound index that backs the user-facing grant list query:
 *   { userId: 1, revokedAt: 1, createdAt: -1 }
 *
 * listActiveByUser() filters on (userId, revokedAt: null) and sorts by createdAt desc.
 * Without this index that query scans every grant for the user. autoIndex is off in
 * deployed environments, so the OAuthGrantSchema.index() declaration never actually
 * builds there; this migration is the only thing that creates it.
 *
 * Id backdated to 20260921235960 to stay below BackfillOAuthClientTokenEndpointAuthMethod
 * (20260922000001), which must remain the highest-id migration on disk - its own test
 * asserts that invariant so its fail-closed throw does not block later migrations.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260921235960,
  name: 'ensure oauthgrant user-revoked-createdat index',

  up: async () => {
    await OAuthGrantModel.createIndexes();
  },

  down: async () => {
    // One-way. Dropping it would degrade listActiveByUser to a full user-grant scan.
  },
};

export default migration;
