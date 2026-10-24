import { OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX, OverwatchUserDay } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ productId, date }` index over `lane: 'synthetic'` rows exists on overwatchuserdays.
 *
 * Synthetic-lane activity reads (that lane's DAU, WAU and MAU, and per-product daily counts over up to
 * 90 days) match `{ productId or $in, date range or $in, lane: 'synthetic' }`. `lane` is in no index,
 * so on `{ productId, date, userId }` each one fetches every user-day of every product in the range to
 * keep the few marked rows. Partial on the mark, the index holds only those rows: an unmarked write
 * adds no key, and reads that do not ask for the lane cannot pick it.
 *
 * A migration as well as the schema declaration, as 20260921235977_ensure-overwatch-raw-event-explorer-index:
 * web `dependsOn` the migration, so the index is committed before web serves the deploy. autoIndex is on
 * and the other Lambdas deploy alongside the migrator, so a cold boot may start this build first;
 * createIndex then waits for that build. A build past the connection's 45s socket timeout fails this
 * run, but the server finishes the build and the next deploy's run finds it. The build reads every
 * user-day, marked or not; the collection is capped by its 180-day TTL.
 *
 * Builds only this index, not OverwatchUserDay.createIndexes(), so a stage missing another declared index
 * does not build it here too. Named and optioned exactly as the schema declares it, so autoIndex after
 * this is a no-op. Idempotent: createIndex is a no-op when an identical index already exists.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235978,
  name: 'ensure overwatch user day synthetic lane index',

  up: async () => {
    await OverwatchUserDay.collection.createIndex(
      { productId: 1, date: 1 },
      { name: OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX, partialFilterExpression: { lane: 'synthetic' } }
    );
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put every synthetic-lane read back on a scan
    // of the whole range. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
