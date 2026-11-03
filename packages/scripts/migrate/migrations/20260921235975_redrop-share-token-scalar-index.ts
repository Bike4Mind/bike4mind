import { PublishedArtifact, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Drop the legacy `shareToken_1` index again, and the scalars it covered.
 *
 * 20260921140000_drop-share-token-scalar dropped both in the same deploy that took them off the
 * schema, while processes still on the old build (web Lambdas, chat-completion tasks) could boot,
 * rebuild the index through autoIndex and write the scalars on a mint or rotate. No deployed build
 * declares either any more, so this cleanup stays done.
 *
 * Idempotent: rows without the scalars and a missing index are skipped. `down` is a no-op.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235975,
  name: 'redrop-share-token-scalar-index',

  up: async () => {
    // Raw collection: the paths are off the schema, so strict mode would strip a model-level $unset.
    const unset = await PublishedArtifact.collection.updateMany(
      { $or: [{ shareToken: { $exists: true } }, { shareTokenUpdatedAt: { $exists: true } }] },
      { $unset: { shareToken: '', shareTokenUpdatedAt: '' } }
    );
    console.log(`[redrop-share-token-scalar-index] unset the legacy scalars on ${unset.modifiedCount} row(s)`);
    await safeDropIndex(PublishedArtifact.collection, 'shareToken_1');
  },

  down: async () => {},
};

export default migration;
