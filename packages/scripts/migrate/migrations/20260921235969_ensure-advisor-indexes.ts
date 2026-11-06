import type { Collection, Connection } from 'mongoose';
import { CounterLog, FabFile, Quest, Session, UserApiKey, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

type IndexKey = Record<string, 1 | -1>;
type IndexedModel = { db: Connection; collection: Collection };

/** An index prod still carries that no schema declares, and the declared index it is a prefix of. */
type RedundantIndex = { model: IndexedModel; key: IndexKey; coveredBy: IndexKey };

export const REDUNDANT_INDEXES: RedundantIndex[] = [
  { model: UserApiKey, key: { userId: 1 }, coveredBy: { userId: 1, status: 1 } },
  {
    model: FabFile,
    key: { deletedAt: 1, sessionId: 1 },
    coveredBy: { deletedAt: 1, sessionId: 1, createdAt: 1, userId: 1 },
  },
];

const sameKey = (a: Record<string, unknown>, b: IndexKey) => JSON.stringify(a) === JSON.stringify(b);

async function dropRedundantIndex({ model, key, coveredBy }: RedundantIndex): Promise<void> {
  const db = model.db.db;
  if (!db) throw new Error('No active MongoDB connection - cannot check index state');

  const collectionName = model.collection.collectionName;
  if ((await db.listCollections({ name: collectionName }).toArray()).length === 0) return;

  const indexes = await model.collection.indexes();
  // Only a plain index is redundant by key: a unique, TTL, partial or sparse one carries a constraint
  // or a narrower scope its covering index does not.
  const redundant = indexes.find(
    index =>
      sameKey(index.key, key) &&
      !index.unique &&
      index.expireAfterSeconds === undefined &&
      !index.partialFilterExpression &&
      !index.sparse
  );
  // Never leave the collection without the prefix: drop only once the covering index exists.
  if (!redundant?.name || !indexes.some(index => sameKey(index.key, coveredBy))) return;
  await safeDropIndex(model.collection, redundant.name);
}

/**
 * Build the indexes the Atlas Performance Advisor found missing, and drop two stale ones it found
 * redundant:
 * - sessions: `{ knowledgeIds, deletedAt }` (findAllWithKnowledgeId, every file delete / lake purge)
 *   and the partial `userId_1_slackNotebook` (the Slack gear check).
 * - quests: sparse `contextTelemetry_anonymousSessionHash` (telemetry opt-out delete and exports).
 * - counterlogs: `{ userId, createdAt: -1 }` (findRecentByUserIdAndHasMetadata).
 * - drops `userapikeys.userId_1` and `fabfiles.deletedAt_1_sessionId_1`: neither is declared by a
 *   schema any more, and each is a prefix of a declared index. createIndexes never drops anything.
 *
 * Migration rather than autoIndex: an autoIndex build is fire-and-forget (a failure is silent) and
 * would start on whichever Lambda cold-boots onto the collection first after deploy. Redundant
 * indexes are found by key pattern, since the name they were built under is not guaranteed.
 *
 * Idempotent: createIndexes is a no-op for an index that already exists with the same options (it
 * throws on an options conflict; prod's existing indexes on these three collections match their
 * schemas), and a missing collection or already dropped index is skipped. Id backdated below BackfillOAuthClientTokenEndpointAuthMethod
 * (20260922000001), which must stay last.
 */
const migration: MigrationFile = {
  id: 20260921235969,
  name: 'ensure advisor indexes',

  up: async () => {
    await Session.createIndexes();
    await Quest.createIndexes();
    await CounterLog.createIndexes();
    for (const redundantIndex of REDUNDANT_INDEXES) await dropRedundantIndex(redundantIndex);
  },

  down: async () => {
    // The added indexes are additive and the dropped ones are covered by a longer index, so
    // reverting either way only costs reads. Removal, if ever wanted, is a forward migration.
  },
};

export default migration;
