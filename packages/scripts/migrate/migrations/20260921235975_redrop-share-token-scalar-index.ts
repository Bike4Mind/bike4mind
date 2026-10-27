import { PublishedArtifact, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Drop the legacy `shareToken_1` index again.
 *
 * 20260921140000_drop-share-token-scalar dropped it in the same deploy that took `{ shareToken: 1 }`
 * off the schema, while Lambdas still running the old schema could cold-boot and rebuild it through
 * autoIndex. No deployed code declares it any more, so a drop now stays dropped.
 *
 * Idempotent: a missing index is skipped. `down` is a no-op; nothing reads the field.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235975,
  name: 'redrop-share-token-scalar-index',

  up: async () => {
    await safeDropIndex(PublishedArtifact.collection, 'shareToken_1');
  },

  down: async () => {},
};

export default migration;
