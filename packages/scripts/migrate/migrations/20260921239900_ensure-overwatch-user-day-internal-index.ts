import { OVERWATCH_USER_DAY_INTERNAL_INDEX, OverwatchUserDay } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial `{ productId, date }` index over `internal: true` rows exists on overwatchuserdays.
 *
 * Internal-account activity reads (that mark's DAU, WAU and MAU) match `{ productId, date range,
 * internal: true }`, or ask for either mark with one `$or` branch per mark. `internal` is in no index,
 * so on `{ productId, date, userId }` each one fetches every user-day of the product in the range to
 * keep the few marked rows.
 * Partial on the mark, the index holds only those rows, as the synthetic-lane index
 * (20260921235978_ensure-overwatch-user-day-synthetic-lane-index) does for its mark.
 *
 * A migration as well as the schema declaration, for the reasons that one gives: web `dependsOn` the
 * migration, so the index is committed before web serves the deploy, and a cold boot's autoIndex build
 * that starts first makes createIndex wait for it. The build reads every user-day, marked or not; the
 * collection is capped by its 180-day TTL.
 *
 * Builds only this index, named and optioned exactly as the schema declares it, so autoIndex after
 * this is a no-op. Idempotent: createIndex is a no-op when an identical index already exists.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921239900,
  name: 'ensure overwatch user day internal index',

  up: async () => {
    await OverwatchUserDay.collection.createIndex(
      { productId: 1, date: 1 },
      { name: OVERWATCH_USER_DAY_INTERNAL_INDEX, partialFilterExpression: { internal: true } }
    );
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put every internal read back on a scan of the
    // whole range. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
