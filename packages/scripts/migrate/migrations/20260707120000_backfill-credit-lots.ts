import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: backfill one `legacy` CreditLot per holder (User / Organization
 * / Agent) with `currentCredits > 0`, so the new dated-expiry lot ledger has
 * a starting point for balances that predate it. `expiresAt` is deploy time +
 * 12 months (same policy as a pack purchase).
 *
 * Idempotent: skips any holder that already has a `legacy` lot (re-running
 * this migration, or a holder onboarded between the id being registered and
 * it actually running, never double-backfills).
 *
 * Raw collections + `_id`-cursor batching (not the Mongoose models), matching
 * 20260529120000_backfill-credit-transaction-source.ts: avoids holding a lock
 * across the whole users/organizations/agents collections in one query.
 */

const BATCH_SIZE = 1000;
const LEGACY_EXPIRY_MONTHS = 12;

type Db = NonNullable<typeof mongoose.connection.db>;

async function backfillHolderType(db: Db, collectionName: string, ownerType: string, expiresAt: Date): Promise<number> {
  const holders = db.collection(collectionName);
  const creditLots = db.collection('creditlots');

  let totalCreated = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  while (true) {
    const filter: Record<string, unknown> = { currentCredits: { $gt: 0 } };
    if (lastId) filter._id = { $gt: lastId };

    const batch = await holders
      .find(filter, { projection: { _id: 1, currentCredits: 1 } })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray();

    if (batch.length === 0) break;

    const ids = batch.map(doc => String(doc._id));
    const existing = await creditLots.find({ ownerId: { $in: ids }, ownerType, source: 'legacy' }).toArray();
    const alreadyBackfilled = new Set(existing.map(doc => doc.ownerId));

    const now = new Date();
    const toInsert = batch
      .filter(doc => !alreadyBackfilled.has(String(doc._id)))
      .map(doc => ({
        ownerId: String(doc._id),
        ownerType,
        source: 'legacy',
        amount: doc.currentCredits,
        expiresAt,
        consumedAssigned: 0,
        createdAt: now,
        updatedAt: now,
      }));

    if (toInsert.length > 0) {
      await creditLots.insertMany(toInsert, { ordered: false });
      totalCreated += toInsert.length;
    }

    lastId = batch[batch.length - 1]._id;
    if (batch.length < BATCH_SIZE) break;
  }

  return totalCreated;
}

const migration: MigrationFile = {
  id: 20260707120000,
  name: 'backfill credit lots',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + LEGACY_EXPIRY_MONTHS);

    const userCount = await backfillHolderType(db, 'users', 'User', expiresAt);
    console.log(`✅ Backfilled ${userCount} legacy credit lots for users`);

    const orgCount = await backfillHolderType(db, 'organizations', 'Organization', expiresAt);
    console.log(`✅ Backfilled ${orgCount} legacy credit lots for organizations`);

    const agentCount = await backfillHolderType(db, 'agents', 'Agent', expiresAt);
    console.log(`✅ Backfilled ${agentCount} legacy credit lots for agents`);
  },

  down: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const result = await db.collection('creditlots').deleteMany({ source: 'legacy' });
    console.log(`Removed ${result.deletedCount} legacy credit lots`);
  },
};

export default migration;
