import { safeDropIndex, User } from '@bike4mind/database';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import { type MigrationFile } from './index';

const LOG = '[backfill-user-provider-end-user-id]';
const BATCH_SIZE = 1000;
const INDEX_NAME = 'user_providerEndUserId';

/**
 * Store `providerEndUserId` (toProviderEndUserId of `_id`, the identifier LLM providers receive) on
 * every account created before the User pre-save hook set it, then build the index the admin lookup
 * reads. Keyset-paged on `_id` so a re-run resumes where a timed-out one stopped.
 *
 * Idempotent: rows that already carry the field are skipped, and createIndex is a no-op for an
 * index that already matches. Index spec and name must match the UserSchema declaration.
 */
const migration: MigrationFile = {
  id: 20260921241030,
  name: 'backfill user providerEndUserId',

  up: async () => {
    let lastId: unknown = null;
    let updated = 0;
    for (;;) {
      const rows: { _id: unknown }[] = await User.find({
        providerEndUserId: { $exists: false },
        ...(lastId === null ? {} : { _id: { $gt: lastId } }),
      })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .select('_id')
        .lean();
      if (rows.length === 0) break;
      const result = await User.bulkWrite(
        rows.map(row => ({
          updateOne: {
            filter: { _id: row._id, providerEndUserId: { $exists: false } },
            update: { $set: { providerEndUserId: toProviderEndUserId(String(row._id)) } },
          },
        })),
        { ordered: false }
      );
      updated += result.modifiedCount;
      lastId = rows[rows.length - 1]._id;
    }
    console.log(`${LOG} stamped ${updated} account(s)`);

    await User.collection.createIndex(
      { providerEndUserId: 1 },
      { unique: true, partialFilterExpression: { providerEndUserId: { $type: 'string' } }, name: INDEX_NAME }
    );
    console.log(`${LOG} ensured ${INDEX_NAME} index`);
  },

  // Drops only the index: the stored value is derived from _id and harmless to keep.
  down: async () => {
    await safeDropIndex(User.collection, INDEX_NAME);
  },
};

export default migration;
