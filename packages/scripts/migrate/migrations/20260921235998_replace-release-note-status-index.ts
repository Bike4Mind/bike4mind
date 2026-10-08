import { ReleaseNote } from '@bike4mind/database';
import { type MigrationFile } from './index';

const OLD_INDEX = 'status_1_publishAt_-1';
const INDEX_NOT_FOUND = 27;

/**
 * Swap release_notes' { status, publishAt } index for the named { status, publishAt, _id } one the
 * keyset-paged reader and admin lists sort on. Neither autoIndex nor createIndexes drops an index the
 * schema stopped declaring, so the old one is dropped explicitly.
 *
 * Idempotent: a missing old index is ignored and createIndexes is a no-op for existing indexes.
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay last.
 */
const migration: MigrationFile = {
  id: 20260921235998,
  name: 'replace release note status index',

  up: async () => {
    try {
      await ReleaseNote.collection.dropIndex(OLD_INDEX);
    } catch (err) {
      if ((err as { code?: unknown }).code !== INDEX_NOT_FOUND) throw err;
    }
    await ReleaseNote.createIndexes();
  },

  down: async () => {
    // The new index is a superset of the old one's prefix, so leaving it in place is safe.
  },
};

export default migration;
