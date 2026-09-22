import { DataLakeFindingModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the DataLakeFinding collection's indexes (#3039).
 *
 * The identity index `{lakeId, detector, kind, subject}` is UNIQUE and load-bearing for
 * correctness, not speed: `recordDetected` is a single upsert against exactly that key, so the
 * index is the only thing that makes two concurrent detection runs over one lake converge on one
 * row. Without it they both insert and a curator gets the same problem twice - the duplication the
 * whole model exists to prevent. That makes it an index that has to exist BEFORE the first write,
 * which is precisely what autoIndex cannot promise.
 *
 * Migration rather than autoIndex, for the reasons the sibling ensure-*-index migrations give:
 * `mongo.ts` sets autoIndex but only awaits `connect`, so a build is fire-and-forget and a failure
 * is silent; and prod runs DocumentDB, where a build takes a foreground collection lock - taken by
 * whichever Lambda cold-boots onto the collection first, i.e. a user's request rather than a
 * migration window. An already-applied sibling cannot backfill this one either: `selectPending`
 * filters on the applied-id set, so it will never re-run to pick up a later-declared index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and it builds every index
 * the schema declares, so it also backfills any this environment happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260921000000,
  name: 'ensure data lake finding indexes',

  up: async () => {
    await DataLakeFindingModel.createIndexes();
  },

  down: async () => {
    // Dropping the identity index would let concurrent detection runs duplicate findings, so this
    // is not reversible by design. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
