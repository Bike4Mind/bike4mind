import { CreditTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

const OLD_INDEX_KEY = { ownerId: 1, ownerType: 1, createdAt: -1 };

/**
 * Swap credit_transactions' { ownerId, ownerType, createdAt } index for the named
 * { ownerId, ownerType, createdAt, _id } one the admin credit ledger pages on (findLedgerPage).
 *
 * Migration rather than autoIndex: autoIndex builds are fire-and-forget (a failure is silent) and
 * would run on whichever Lambda cold-boots first, on a collection every usage write touches. Neither
 * autoIndex nor createIndexes drops an index the schema stopped declaring, and the old one is a
 * strict prefix of the new one, so left in place it would only cost every write.
 *
 * The new index is built before the old one is dropped so the owner queries never lose an index.
 * The old index is found by key pattern, not by its auto-derived name, which is not guaranteed.
 * Idempotent: createIndexes is a no-op for existing indexes and a missing old index is skipped.
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay last.
 */
const migration: MigrationFile = {
  id: 20260921235957,
  name: 'replace credit transaction owner index',

  up: async () => {
    await CreditTransaction.createIndexes();

    const oldIndex = (await CreditTransaction.collection.indexes()).find(
      index => JSON.stringify(index.key) === JSON.stringify(OLD_INDEX_KEY)
    );
    if (oldIndex?.name) await CreditTransaction.collection.dropIndex(oldIndex.name);
  },

  down: async () => {
    // The new index serves every query the old one did (it is a superset of its prefix), so leaving
    // it in place is safe.
  },
};

export default migration;
